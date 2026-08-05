// The left pane: every repository in the workspace, all visible at once.
//
// Two rules keep it readable at this density:
//   1. a clean repo is a single line — no body, no placeholder text;
//   2. files that share a directory are gathered under one dim heading
//      instead of repeating the same path fifteen times.

import type { ChangeEntry, RepoSummary, StatusCode, TreeEntry } from '../shared/types.ts'
import { api } from './api.ts'
import { actionButton, byId, el } from './dom.ts'
import { docKey, hooks, repoColor, state, type Doc } from './state.ts'

const host = byId('sidebar')
const tabsHost = byId('tabs')

// Reused across renders so a half-typed commit message and its focus survive a refresh.
const commitBoxes = new Map<string, { root: HTMLElement; textarea: HTMLTextAreaElement; button: HTMLButtonElement }>()

/** The gutter mark for a change: what happened, in one character. */
const MARK: Record<StatusCode, [mark: string, tone: string, label: string]> = {
  M: ['M', 'g-mod', 'modified'],
  A: ['+', 'g-new', 'added'],
  '?': ['+', 'g-new', 'new file'],
  D: ['−', 'g-del', 'deleted'],
  R: ['→', 'g-move', 'renamed'],
  C: ['⇉', 'g-move', 'copied'],
  U: ['!', 'g-warn', 'conflict'],
  T: ['T', 'g-mod', 'type changed'],
}

export function renderSidebar(): void {
  renderTabs()
  if (state.tab === 'files') return host.replaceChildren(projectTree())

  const repos = state.workspace.repos.filter(repo => state.showHidden || !repo.hidden)
  const busy = repos.filter(repo => repo.staged || repo.changes || state.errors[repo.id] || repo.error)
  const quiet = repos.filter(repo => !busy.includes(repo))

  host.replaceChildren(
    ...(repos.length ? busy.map(repoSection) : [el('div', 'empty', 'No repositories here.')]),
    ...(quiet.length ? [quietBlock(quiet)] : [])
  )
}

function renderTabs(): void {
  const total = state.workspace.repos.reduce((sum, repo) => sum + repo.staged + repo.changes, 0)
  const tabs: Array<[key: 'changes' | 'files', label: string, badge: string]> = [
    ['changes', 'Changes', total ? String(total) : ''],
    ['files', 'Files', ''],
  ]
  tabsHost.replaceChildren(
    ...tabs.map(([key, label, badge]) => {
      const button = el('button', `tab${state.tab === key ? ' on' : ''}`, label)
      if (badge) button.append(el('span', 'tab-n', badge))
      button.addEventListener('click', () => {
        state.tab = key
        renderSidebar()
      })
      return button
    })
  )
}

/** Repos with nothing going on are parked together at the bottom, one line each. */
function quietBlock(repos: RepoSummary[]): HTMLElement {
  const block = el('div', 'quiet')
  block.append(el('div', 'label quiet-label', `${repos.length} clean`))
  block.append(...repos.map(repoSection))
  return block
}

function repoSection(repo: RepoSummary): HTMLElement {
  const section = el('section', 'repo')
  section.dataset.repo = repo.id
  section.style.setProperty('--id', repoColor(repo.id))
  if (repo.hidden) section.classList.add('is-hidden')
  if (repo.staged || repo.changes) section.classList.add('dirty')

  section.append(repoRow(repo))
  if (repo.hidden || state.collapsed.has(repo.id)) return section

  const report = state.statuses[repo.id]
  const staged = report?.staged ?? []
  const changed = report?.changes ?? []
  const showsWorktrees = state.worktreesOpen.has(repo.id)
  if (!repo.error && !state.errors[repo.id] && !staged.length && !changed.length && !showsWorktrees) {
    return section // a clean repo stays one line tall
  }

  const body = el('div', 'repo-body')
  section.append(body)

  if (repo.error) {
    body.append(el('div', 'err', repo.error))
    return section
  }
  if (state.errors[repo.id]) body.append(el('div', 'err', state.errors[repo.id]!))
  if (showsWorktrees) body.append(worktreeList(repo))
  if (staged.length) {
    body.append(commitBox(repo))
    body.append(section_('Staged', staged.length, 'Unstage all', () => bulk(repo, false)), fileList(repo, staged, true))
  }
  if (changed.length) {
    body.append(section_('Changed', changed.length, 'Stage all', () => bulk(repo, true)), fileList(repo, changed, false))
  }
  return section
}

function repoRow(repo: RepoSummary): HTMLElement {
  const row = el('div', 'row repo-row')
  const tone = repo.staged ? 'g-new' : repo.changes ? 'g-mod' : ''
  row.append(el('span', `gut ${tone}`, repo.staged || repo.changes ? '●' : ''))
  row.append(el('span', 'repo-name', repo.name))
  if (repo.qualifier) row.append(el('span', 'repo-qual', repo.qualifier))
  if (repo.isWorktree) row.append(el('span', 'repo-flag', 'worktree'))
  if (repo.branch) row.append(el('span', 'repo-branch', repo.branch))

  const sync = `${repo.behind ? `↓${repo.behind}` : ''}${repo.ahead ? `↑${repo.ahead}` : ''}`
  if (sync) row.append(el('span', 'repo-sync', sync))

  if (repo.worktrees > 1) {
    const chip = el('button', 'repo-wt', `⑂${repo.worktrees}`)
    chip.title = 'Worktrees'
    chip.addEventListener('click', event => {
      event.stopPropagation()
      void toggleWorktrees(repo.id)
    })
    row.append(chip)
  }

  const tally = el('span', 'tally')
  if (repo.staged) tally.append(el('b', 't-staged', String(repo.staged)))
  if (repo.changes) tally.append(el('b', 't-changed', String(repo.changes)))
  row.append(tally)

  const controls = el('span', 'ctl')
  controls.append(
    actionButton('↑', 'Move up', () => move(repo.id, -1)),
    actionButton('↓', 'Move down', () => move(repo.id, 1)),
    actionButton(repo.hidden ? 'show' : 'hide', repo.hidden ? 'Show this repo' : 'Hide this repo', async () => {
      await api.prefs(repo.id, { hidden: !repo.hidden })
      await hooks.refresh()
    })
  )
  if (repo.pinned) {
    controls.append(
      actionButton('drop', 'Remove from the list', async () => {
        await api.removeRepo(repo.id)
        await hooks.refresh()
      })
    )
  }
  row.append(controls)

  row.title = repo.id
  if (!repo.staged && !repo.changes) row.classList.add('quiet-row')
  row.addEventListener('click', () => {
    if (repo.hidden || (!repo.staged && !repo.changes)) return
    if (state.collapsed.has(repo.id)) state.collapsed.delete(repo.id)
    else state.collapsed.add(repo.id)
    renderSidebar()
  })
  return row
}

function section_(title: string, count: number, bulkLabel: string, onBulk: () => void): HTMLElement {
  const head = el('div', 'sect')
  head.append(el('span', 'label', title), el('span', 'count', String(count)))
  head.append(actionButton(bulkLabel.toLowerCase(), bulkLabel, onBulk))
  return head
}

const dirOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf('/')
  return cut === -1 ? '' : filePath.slice(0, cut)
}

/**
 * Directories that hold two or more changed files get a heading and the files
 * below it lose their path. A lone file keeps its directory inline — a heading
 * for one row would cost two lines to say what one can.
 */
function fileList(repo: RepoSummary, entries: ChangeEntry[], staged: boolean): HTMLElement {
  const list = el('ul', 'files')
  const perDir = new Map<string, number>()
  for (const entry of entries) perDir.set(dirOf(entry.path), (perDir.get(dirOf(entry.path)) ?? 0) + 1)

  let lastHeading: string | null = null
  for (const entry of entries) {
    const dir = dirOf(entry.path)
    const name = dir ? entry.path.slice(dir.length + 1) : entry.path
    const grouped = dir !== '' && (perDir.get(dir) ?? 0) > 1

    if (grouped && dir !== lastHeading) {
      lastHeading = dir
      const heading = el('li', 'dirhead')
      heading.append(el('span', '', `${dir}/`))
      heading.title = dir
      list.append(heading)
    }
    if (!grouped) lastHeading = null
    list.append(fileRow(repo, entry, name, staged, grouped ? '' : dir))
  }
  return list
}

function fileRow(
  repo: RepoSummary,
  entry: ChangeEntry,
  name: string,
  staged: boolean,
  inlineDir: string
): HTMLLIElement {
  const doc: Doc = { kind: 'diff', repo: repo.id, path: entry.path, staged, untracked: Boolean(entry.untracked) }
  const [mark, tone, label] = MARK[entry.status] ?? ['·', '', entry.status]

  const item = el('li', 'row file')
  item.classList.toggle('active', docKey(doc) === docKey(state.doc))
  item.title = `${entry.path} — ${label}`
  item.append(el('span', `gut ${tone}`, mark), el('span', 'fname', name))
  if (inlineDir) item.append(el('span', 'fdir', inlineDir))

  const actions = el('span', 'actions')
  actions.append(
    actionButton(staged ? 'unstage' : 'stage', staged ? 'Unstage this file' : 'Stage this file', async () => {
      await (staged ? api.unstage(repo.id, [entry.path]) : api.stage(repo.id, [entry.path]))
      await hooks.refresh([repo.id])
    })
  )
  if (!staged && !entry.untracked) {
    actions.append(
      actionButton('discard', 'Throw away these changes', async () => {
        if (!confirm(`Discard local changes in ${entry.path}?`)) return
        await api.discard(repo.id, [entry.path])
        await hooks.refresh([repo.id])
      })
    )
  }
  item.append(actions)
  item.addEventListener('click', () => void hooks.open(doc))
  return item
}

// ------------------------------------------------------------- commit box
function commitBox(repo: RepoSummary): HTMLElement {
  let box = commitBoxes.get(repo.id)
  if (!box) {
    const root = el('div', 'commit')
    const textarea = el('textarea')
    textarea.rows = 2
    textarea.placeholder = 'Commit message'
    const button = el('button', '', 'Commit')

    const sync = () => {
      button.disabled = !textarea.value.trim() || !currentStaged(repo.id)
    }
    textarea.addEventListener('input', sync)
    textarea.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') void commit(repo.id, textarea)
    })
    button.addEventListener('click', () => void commit(repo.id, textarea))

    root.append(textarea, button)
    box = { root, textarea, button }
    commitBoxes.set(repo.id, box)
  }
  box.button.disabled = !box.textarea.value.trim() || !currentStaged(repo.id)
  return box.root
}

const currentStaged = (repoId: string): number => state.statuses[repoId]?.staged.length ?? 0

async function commit(repoId: string, textarea: HTMLTextAreaElement): Promise<void> {
  const message = textarea.value.trim()
  if (!message) return
  const result = await api.commit(repoId, message)
  if (result.ok) {
    textarea.value = ''
    delete state.errors[repoId]
  } else state.errors[repoId] = result.error
  await hooks.refresh([repoId])
}

async function bulk(repo: RepoSummary, stage: boolean): Promise<void> {
  await (stage ? api.stage(repo.id, []) : api.unstage(repo.id, []))
  await hooks.refresh([repo.id])
}

// --------------------------------------------------------------- ordering
async function move(repoId: string, delta: number): Promise<void> {
  const ids = state.workspace.repos.map(repo => repo.id)
  const from = ids.indexOf(repoId)
  const to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return
  ids.splice(to, 0, ...ids.splice(from, 1))
  await api.reorder(ids)
  await hooks.refresh()
}

// -------------------------------------------------------------- worktrees
async function toggleWorktrees(repoId: string): Promise<void> {
  if (state.worktreesOpen.has(repoId)) state.worktreesOpen.delete(repoId)
  else {
    state.worktreesOpen.add(repoId)
    state.worktrees[repoId] = await api.worktrees(repoId)
  }
  renderSidebar()
}

function worktreeList(repo: RepoSummary): HTMLElement {
  const list = el('ul', 'wt')
  for (const tree of state.worktrees[repo.id] ?? []) {
    const item = el('li', 'row')
    item.title = tree.path
    if (tree.current) item.classList.add('current')
    item.append(el('span', 'gut', tree.current ? '●' : ''), el('span', 'wt-branch', tree.branch))
    item.append(el('span', 'wt-path', tree.path.replace(state.workspace.root + '/', '')))

    if (!tree.known) {
      const actions = el('span', 'actions')
      actions.append(
        actionButton('add', 'Keep this worktree in the list', async () => {
          await api.addRepo(tree.path)
          state.worktrees[repo.id] = await api.worktrees(repo.id)
          await hooks.refresh()
        })
      )
      item.append(actions)
    } else if (!tree.current) {
      item.classList.add('linked')
      item.addEventListener('click', () => {
        state.collapsed.delete(tree.path)
        renderSidebar()
        host.querySelector(`[data-repo="${CSS.escape(tree.path)}"]`)?.scrollIntoView({ block: 'nearest' })
      })
    }
    list.append(item)
  }
  return list
}

// ------------------------------------------------------------------ files
// The Files tab is one tree over the whole project — the directories between
// repositories belong to it too, so browsing is not scoped to a checkout.

let projectTreeEl: HTMLUListElement | null = null

function projectTree(): HTMLElement {
  if (!projectTreeEl) {
    projectTreeEl = el('ul', 'tree ws')
    void fillTree(projectTreeEl, '')
  }
  return projectTreeEl
}

async function fillTree(node: HTMLElement, dir: string): Promise<void> {
  const entries = await api.wsTree(dir)
  node.replaceChildren(...entries.map(treeNode))
}

/** Re-reads the project tree when it is the visible tab. */
export async function refreshTrees(_repoIds: string[]): Promise<void> {
  if (state.tab === 'files' && projectTreeEl) await fillTree(projectTreeEl, '')
}

function treeNode(entry: TreeEntry): HTMLLIElement {
  const node = el('li')
  const row = el('div', 'row tree-row')
  row.dataset.path = entry.path
  if (entry.ignored) row.classList.add('ignored')
  if (entry.dir) row.classList.add('dir')

  if (entry.repo) {
    // A repository in the tree carries the same colour as its block in Changes.
    row.classList.add('is-repo')
    row.style.setProperty('--id', repoColor(`${state.workspace.root}/${entry.path}`))
  }
  row.append(el('span', 'gut', entry.dir ? '▸' : ''), el('span', 'fname', entry.name))
  node.append(row)

  if (!entry.dir) {
    const doc: Doc = { kind: 'wsfile', path: entry.path }
    row.classList.toggle('active', docKey(doc) === docKey(state.doc))
    row.addEventListener('click', () => void hooks.open(doc))
    return node
  }

  const children = el('ul', 'tree')
  children.hidden = true
  node.append(children)

  const toggle = async () => {
    const opening = children.hidden
    children.hidden = !opening
    row.querySelector('.gut')!.textContent = opening ? '▾' : '▸'
    if (opening) {
      state.wsExpanded.add(entry.path)
      if (!children.childElementCount) await fillTree(children, entry.path)
    } else state.wsExpanded.delete(entry.path)
  }

  row.addEventListener('click', () => void toggle())
  if (state.wsExpanded.has(entry.path)) void toggle()
  return node
}
