// The right-hand pane: exactly one file or one diff at a time.

import { api } from './api.ts'
import { countChanges, parseDiff, type DiffRow } from './diff.ts'
import { actionButton, byId, el } from './dom.ts'
import { escapeHtml, highlight, languageOf } from './highlight.ts'
import { formatSize, hooks, repoColor, state, type Doc } from './state.ts'

const headEl = byId('viewerHead')
const bodyEl = byId('viewerBody')

const repoName = (id: string): string => state.workspace.repos.find(repo => repo.id === id)?.name ?? id

export async function openDoc(doc: Doc): Promise<void> {
  state.doc = doc
  if (doc.kind !== 'wsfile') void api.focus(doc.repo) // ask the server to watch this repo closely
  await render(doc)
}

/** Re-renders whatever is open, keeping the scroll position. */
export async function refreshDoc(): Promise<void> {
  if (!state.doc) return
  const scroll = bodyEl.scrollTop
  try {
    await render(state.doc)
    bodyEl.scrollTop = scroll
  } catch {
    // The open file was deleted or renamed underneath us.
    setHead(null, state.doc.path, metaText('gone'), [])
    bodyEl.innerHTML = '<div class="blank"><p>This file no longer exists.</p></div>'
    state.doc = null
  }
}

function render(doc: Doc): Promise<void> {
  if (doc.kind === 'diff') return renderDiff(doc)
  if (doc.kind === 'file') return renderFile(doc)
  return renderWorkspaceFile(doc)
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

function renderSource(payload: { size: number; content?: string; binary?: boolean; tooBig?: boolean }, filePath: string): void {
  if (payload.binary || payload.tooBig) {
    const what = payload.binary ? 'Binary file' : 'File too large to display'
    bodyEl.innerHTML = `<div class="blank"><p>${what} — ${formatSize(payload.size)}</p></div>`
    return
  }
  const content = payload.content ?? ''
  const numbers = content.split('\n').map((_, index) => index + 1).join('\n')
  bodyEl.innerHTML =
    `<div class="code"><pre class="ln">${numbers}</pre>` +
    `<pre class="src">${highlight(content, languageOf(filePath))}</pre></div>`
}

async function renderFile(doc: Extract<Doc, { kind: 'file' }>): Promise<void> {
  const payload = await api.file(doc.repo, doc.path)
  setHead(doc.repo, doc.path, metaText(formatSize(payload.size)), [
    actionButton('diff', 'Show working-tree diff for this file', () =>
      hooks.open({ kind: 'diff', repo: doc.repo, path: doc.path, staged: false, untracked: false })
    ),
  ])
  renderSource(payload, doc.path)
}

/** A file from the project tree. It may or may not belong to a repository. */
async function renderWorkspaceFile(doc: Extract<Doc, { kind: 'wsfile' }>): Promise<void> {
  const payload = await api.wsFile(doc.path)
  const actions: HTMLElement[] = []
  if (payload.repo && payload.repoPath) {
    const repo = payload.repo
    const inRepo = payload.repoPath
    actions.push(
      actionButton('diff', 'Show working-tree diff for this file', () =>
        hooks.open({ kind: 'diff', repo, path: inRepo, staged: false, untracked: false })
      )
    )
  }
  setHead(payload.repo ?? null, payload.repoPath ?? doc.path, metaText(formatSize(payload.size)), actions)
  renderSource(payload, doc.path)
}

async function renderDiff(doc: Extract<Doc, { kind: 'diff' }>): Promise<void> {
  const raw = await api.diff(doc.repo, doc.path, doc.staged, doc.untracked)
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
    actionButton('whole file', 'Open the whole file', () =>
      hooks.open({ kind: 'file', repo: doc.repo, path: doc.path })
    ),
  ])

  if (!rows.length) {
    bodyEl.innerHTML = '<div class="blank"><p>No textual changes.</p></div>'
    return
  }

  const language = languageOf(doc.path)
  bodyEl.innerHTML = `<div class="diff">${rows.map(row => diffRowHtml(row, language)).join('')}</div>`
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
