// The right-hand pane: exactly one file or one diff at a time.

import { api } from './api.ts'
import { countChanges, parseDiff, type DiffRow } from './diff.ts'
import { actionButton, byId, el } from './dom.ts'
import { escapeHtml, highlight, languageOf } from './highlight.ts'
import { hooks, repoColor, state, type Doc } from './state.ts'
import { mark } from './trace.ts'

const headEl = byId('viewerHead')
const bodyEl = byId('viewerBody')

const repoName = (id: string): string => state.workspace.repos.find(repo => repo.id === id)?.name ?? id

/** The repo the server was last asked to watch closely. */
let focused = ''

export async function openDoc(doc: Doc): Promise<void> {
  const done = mark(`open ${doc.kind}`)
  state.doc = doc
  // Ask the server to watch this repo closely — but only when the answer would
  // change. Reading ten files in one repo is one request, not ten.
  if (doc.repo !== focused) {
    focused = doc.repo
    void api.focus(doc.repo)
  }
  await renderDiff(doc)
  done(doc.path)
}

/** Re-renders whatever is open, keeping the scroll position. */
export async function refreshDoc(): Promise<void> {
  if (!state.doc) return
  const scroll = bodyEl.scrollTop
  try {
    await renderDiff(state.doc)
    bodyEl.scrollTop = scroll
  } catch {
    // The open file was deleted or renamed underneath us.
    setHead(null, state.doc.path, metaText('gone'), [])
    bodyEl.innerHTML = '<div class="blank"><p>This file no longer exists.</p></div>'
    state.doc = null
  }
}

/** The file's identity, read as one path: the repo owns the colour, the name the weight. */
function setHead(repo: string | null, filePath: string, meta: HTMLElement, actions: HTMLElement[]): void {
  const cut = filePath.lastIndexOf('/')
  const crumb = el('span', 'crumb')
  if (repo) {
    const owner = el('span', 'c-repo', `${repoName(repo)}/`)
    owner.style.color = repoColor(repo)
    crumb.append(owner)
  }
  if (cut !== -1) crumb.append(el('span', 'c-dir', `${filePath.slice(0, cut)}/`))
  crumb.append(el('span', 'c-file', cut === -1 ? filePath : filePath.slice(cut + 1)))
  crumb.title = repo ? `${repoName(repo)}/${filePath}` : filePath
  headEl.replaceChildren(crumb, meta, el('span', 'spacer'), ...actions)
}

const metaText = (text: string): HTMLElement => el('span', 'meta', text)

async function renderDiff(doc: Extract<Doc, { kind: 'diff' }>): Promise<void> {
  const fetched = mark('  fetch diff')
  const raw = await api.diff(doc.repo, doc.path, doc.staged, doc.untracked)
  fetched(`${raw.length} bytes`)
  const rows = parseDiff(raw)
  const { added, removed } = countChanges(rows)

  const meta = el('span', 'meta')
  meta.append(doc.staged ? 'staged' : 'working tree', '  ')
  if (added) meta.append(el('span', 'm-add', `+${added}`), ' ')
  if (removed) meta.append(el('span', 'm-del', `−${removed}`))

  setHead(doc.repo, doc.path, meta, [
    actionButton(doc.staged ? 'unstage' : 'stage', doc.staged ? 'Unstage this file' : 'Stage this file', async () => {
      await (doc.staged ? api.unstage(doc.repo, [doc.path]) : api.stage(doc.repo, [doc.path]))
      await hooks.refresh([doc.repo])
    }),
  ])

  if (!rows.length) {
    bodyEl.innerHTML = '<div class="blank"><p>No textual changes.</p></div>'
    return
  }

  const language = languageOf(doc.path)
  const drawn = mark('  draw diff')
  bodyEl.innerHTML = `<div class="diff">${rows.map(row => diffRowHtml(row, language)).join('')}</div>`
  drawn(`${rows.length} rows`)
}

function diffRowHtml(row: DiffRow, language: ReturnType<typeof languageOf>): string {
  if (row.kind === 'hunk' || row.kind === 'meta') {
    return (
      `<div class="d-row d-${row.kind}"><span class="d-num"></span><span class="d-num"></span>` +
      `<span class="d-text">${escapeHtml(row.text)}</span></div>`
    )
  }
  const sign = row.kind === 'add' ? '+' : row.kind === 'del' ? '−' : ' '
  return (
    `<div class="d-row d-${row.kind}">` +
    `<span class="d-num">${row.oldLine ?? ''}</span>` +
    `<span class="d-num">${row.newLine ?? ''}</span>` +
    `<span class="d-sign">${sign}</span>` +
    `<span class="d-text">${highlight(row.text, language)}</span>` +
    `</div>`
  )
}
