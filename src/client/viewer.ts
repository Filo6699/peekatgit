import { api } from './api.ts'
import { countChanges, parseDiff, type DiffRow } from './diff.ts'
import { actionButton, byId, el } from './dom.ts'
import { operate } from './operations.ts'
import { escapeHtml, highlight, languageOf } from './highlight.ts'
import { changeDocs, docKey, hooks, repoColor, state, type Doc } from './state.ts'

const headEl = byId('viewerHead')
const bodyEl = byId('viewerBody')
const ROW_HEIGHT = 22
let request: AbortController | null = null
let focused = ''
let previous = ''
let previousKey = ''
let previousCounts = { added: 0, removed: 0 }
let stopDrawing = (): void => {}

export async function openDoc(doc: Doc): Promise<void> {
  const changed = docKey(doc) !== docKey(state.doc)
  state.doc = doc
  hooks.paint()
  if (doc.repo !== focused) {
    focused = doc.repo
    void api.focus(doc.repo)
  }
  if (changed) {
    stopDrawing()
    headEl.replaceChildren(el('span', 'crumb', doc.path))
    bodyEl.replaceChildren(el('div', 'blank', 'Loading diff…'))
    bodyEl.scrollTop = bodyEl.scrollLeft = 0
  }
  await renderDiff(doc, !changed)
}

export async function refreshDoc(): Promise<void> {
  if (!state.doc) return
  const doc = state.doc
  const report = state.statuses[doc.repo]
  const same = (doc.staged ? report?.staged : report?.changes)?.find(entry => entry.path === doc.path)
  const other = (doc.staged ? report?.changes : report?.staged)?.find(entry => entry.path === doc.path)
  if (same) state.doc = { ...doc, untracked: Boolean(same.untracked), from: same.from }
  else if (other) state.doc = { ...doc, staged: !doc.staged, untracked: Boolean(other.untracked), from: other.from }
  else {
    request?.abort()
    stopDrawing()
    previousKey = ''
    state.doc = null
    headEl.replaceChildren(el('span', 'crumb', doc.path))
    bodyEl.replaceChildren(el('div', 'blank', 'This change is complete. Select another file to continue.'))
    hooks.paint()
    return
  }
  await renderDiff(state.doc, true)
  hooks.paint()
}

function setHead(doc: Doc, added: number, removed: number): void {
  const repo = state.workspace.repos.find(repo => repo.id === doc.repo)
  const crumb = el('span', 'crumb')
  const owner = el('span', 'c-repo', `${repo?.name ?? doc.repo} / `)
  owner.style.color = repoColor(doc.repo)
  crumb.append(owner, el('span', 'c-file', doc.path))
  crumb.title = doc.path
  const meta = el('span', 'meta', doc.staged ? 'Staged  ' : 'Working tree  ')
  if (added) meta.append(el('span', 'm-add', `+${added} `))
  if (removed) meta.append(el('span', 'm-del', `−${removed}`))
  const docs = changeDocs()
  const index = docs.findIndex(item => docKey(item) === docKey(doc))
  const previous = actionButton('↑', 'Previous change (K)', () => navigateChange(-1))
  const next = actionButton('↓', 'Next change (J)', () => navigateChange(1))
  previous.disabled = index <= 0
  next.disabled = index < 0 || index >= docs.length - 1
  const stage = actionButton(doc.staged ? 'Unstage' : 'Stage file', doc.staged ? 'Unstage this file' : 'Stage this file', () => {
    const paths = doc.from ? [doc.path, doc.from] : [doc.path]
    return operate(doc.repo, doc.staged ? 'Unstaging…' : 'Staging…', () => doc.staged ? api.unstage(doc.repo, paths) : api.stage(doc.repo, paths))
  })
  stage.disabled = state.busy.has(doc.repo)
  headEl.replaceChildren(crumb, meta, el('span', 'spacer'), previous,
    el('span', 'meta', index < 0 ? '' : `${index + 1} / ${docs.length}`), next, stage)
}

async function renderDiff(doc: Doc, preserve: boolean): Promise<void> {
  request?.abort()
  const controller = new AbortController()
  request = controller
  const key = docKey(doc)
  try {
    const raw = await api.diff(doc.repo, doc.path, doc.staged, doc.untracked, controller.signal)
    if (controller.signal.aborted || key !== docKey(state.doc)) return
    if (preserve && raw === previous && key === previousKey) {
      setHead(doc, previousCounts.added, previousCounts.removed)
      return
    }
    const scroll = preserve ? bodyEl.scrollTop : 0
    const rows = parseDiff(raw)
    const { added, removed } = countChanges(rows)
    previousCounts = { added, removed }
    setHead(doc, added, removed)
    stopDrawing()
    if (!rows.length) {
      bodyEl.replaceChildren(el('div', 'blank', 'No changes in this view. Select another file to continue.'))
    } else drawRows(rows, languageOf(doc.path), scroll)
    previous = raw
    previousKey = key
  } catch (error) {
    if (controller.signal.aborted || key !== docKey(state.doc)) return
    stopDrawing()
    previousKey = ''
    bodyEl.replaceChildren(el('div', 'blank err', (error as Error).message))
  }
}

/** Only highlight and mount the visible lines of large patches. */
function drawRows(rows: DiffRow[], language: ReturnType<typeof languageOf>, scroll: number): void {
  const container = el('div', 'diff')
  bodyEl.replaceChildren(container)
  if (rows.length <= 500) {
    container.innerHTML = rows.map(row => rowHtml(row, language)).join('')
    bodyEl.scrollTop = scroll
    return
  }
  container.classList.add('virtual-diff')
  container.style.height = `${rows.length * ROW_HEIGHT}px`
  let longest = 0
  for (const row of rows) longest = Math.max(longest, row.text.replace(/\t/g, '    ').length)
  container.style.minWidth = `calc(${longest}ch + 130px)`
  const windowEl = el('div', 'diff-window')
  container.append(windowEl)
  bodyEl.scrollTop = scroll
  let frame = 0
  let lastStart = -1
  let lastEnd = -1
  const paint = () => {
    frame = 0
    const start = Math.max(0, Math.floor(bodyEl.scrollTop / ROW_HEIGHT) - 15)
    const end = Math.min(rows.length, Math.ceil((bodyEl.scrollTop + bodyEl.clientHeight) / ROW_HEIGHT) + 15)
    if (start === lastStart && end === lastEnd) return
    lastStart = start; lastEnd = end
    windowEl.style.transform = `translateY(${start * ROW_HEIGHT}px)`
    windowEl.innerHTML = rows.slice(start, end).map(row => rowHtml(row, language)).join('')
  }
  const schedule = () => { if (!frame) frame = requestAnimationFrame(paint) }
  bodyEl.addEventListener('scroll', schedule, { passive: true })
  const resize = new ResizeObserver(schedule)
  resize.observe(bodyEl)
  paint()
  stopDrawing = () => {
    cancelAnimationFrame(frame)
    bodyEl.removeEventListener('scroll', schedule)
    resize.disconnect()
    stopDrawing = () => {}
  }
}

function rowHtml(row: DiffRow, language: ReturnType<typeof languageOf>): string {
  const meta = row.kind === 'hunk' || row.kind === 'meta'
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  const text = meta || row.text.length > 2000 ? escapeHtml(row.text) : highlight(row.text, language)
  return `<div class="d-row d-${row.kind}"><span class="d-num">${row.oldLine ?? ''}</span>` +
    `<span class="d-num">${row.newLine ?? ''}</span><span class="d-sign">${sign}</span>` +
    `<span class="d-text">${text}</span></div>`
}

export function navigateChange(delta: number): void {
  const docs = changeDocs()
  const index = docs.findIndex(doc => docKey(doc) === docKey(state.doc))
  const next = docs[index < 0 ? 0 : index + delta]
  if (next) {
    state.collapsed.delete(next.repo)
    void hooks.open(next)
    requestAnimationFrame(() => document.querySelector('.file.active')?.scrollIntoView({ block: 'nearest' }))
  }
}
