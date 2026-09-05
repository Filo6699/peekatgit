// The left pane: every repository in the workspace, all visible at once.
//
// Two rules keep it readable at this density:
//   1. a clean repo is a single line — no body, no placeholder text;
//   2. staged and unstaged files are two banded groups, each in its own
//      colour, so which side of the index you are looking at is never a guess.

import type { ChangeEntry, RepoSummary, StatusCode } from '../shared/types.ts'
import { api } from './api.ts'
import { actionButton, byId, el } from './dom.ts'
import { graphCount, openGraph, scrollToRepo } from './graph.ts'
import { showPane } from './panes.ts'
import { docKey, hooks, repoColor, setTab, state, visibleRepos, type Doc } from './state.ts'

const host = byId('sidebar')
const tabsHost = byId('tabs')
const sections = new Map<string, { key: string; report: unknown; node: HTMLElement }>()
let tabsKey = ''

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
  for (const row of host.querySelectorAll<HTMLElement>('[data-doc]')) {
    row.classList.toggle('active', row.dataset.doc === docKey(state.doc))
  }
  if (state.tab === 'graph') return host.replaceChildren(graphList())

  const repos = state.workspace.repos.filter(repo => state.showHidden || !repo.hidden)
  const busy = repos.filter(repo => repo.staged || repo.changes || state.errors[repo.id] || repo.error)
  const busyIds = new Set(busy.map(repo => repo.id))
  const quiet = repos.filter(repo => !busyIds.has(repo.id))
  const known = new Set(repos.map(repo => repo.id))
  for (const id of sections.keys()) if (!known.has(id)) sections.delete(id)
  const nodes: HTMLElement[] = [...busy, ...quiet].map(cachedSection)
  if (!nodes.length) nodes.push(el('div', 'empty', 'No repositories here.'))
  const active = document.activeElement as HTMLElement | null
  // Move only nodes whose order changed. Unaffected commit inputs keep focus.
  nodes.forEach((node, index) => {
    if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null)
  })
  while (host.children.length > nodes.length) host.lastElementChild!.remove()
  if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true })
}

function cachedSection(repo: RepoSummary): HTMLElement {
  const key = JSON.stringify([repo, state.errors[repo.id], state.collapsed.has(repo.id),
    state.syncing.has(repo.id), state.worktreesOpen.has(repo.id), state.worktrees[repo.id]])
  const previous = sections.get(repo.id)
  const report = state.statuses[repo.id]
  if (previous?.key === key && previous.report === report) return previous.node
  const node = repoSection(repo)
  sections.set(repo.id, { key, report, node })
  return node
}

function renderTabs(): void {
  const total = state.workspace.repos.reduce((sum, repo) => sum + repo.staged + repo.changes, 0)
  const tabs: Array<[key: typeof state.tab, label: string, badge: string]> = [
    ['changes', 'Changes', total ? String(total) : ''],
    ['graph', 'History', ''],
  ]
  const key = `${state.tab}:${total}`
  if (tabsKey === key) return
  tabsKey = key
  tabsHost.replaceChildren(
    ...tabs.map(([key, label, badge]) => {
      const button = el('button', `tab${state.tab === key ? ' on' : ''}`, label)
      if (badge) button.append(el('span', 'tab-n', badge))
      button.addEventListener('click', () => {
        setTab(key)
        // The graph lives in the right-hand pane, so picking it is also a
        // decision about what that pane shows; the other tabs hand it back.
        if (key === 'graph') openGraph()
        else showPane('viewer')
        renderSidebar()
      })
      return button
    })
  )
}

/** The graph tab's sidebar: one line per drawn repository, and a way to it. */
function graphList(): HTMLElement {
  const list = el('div', 'glist')
  const repos = visibleRepos().filter(repo => !repo.hidden)
  if (!repos.length) return el('div', 'empty', 'No repositories here.')

  for (const repo of repos) {
    const row = el('div', 'row glist-row')
    row.style.setProperty('--id', repoColor(repo.id))
    row.title = repo.id
    row.append(el('span', 'gut gdot-cell', '●'), el('span', 'repo-name', repo.name))
    if (repo.branch) row.append(el('span', 'repo-branch', repo.branch))
    row.append(el('span', 'spacer'), el('span', 'count', String(graphCount(repo.id))))
    row.addEventListener('click', () => scrollToRepo(repo.id))
    list.append(row)
  }
  return list
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
    body.append(stageGroup(repo, staged, true))
  }
  if (changed.length) body.append(stageGroup(repo, changed, false))
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

  if (repo.tracking) row.append(syncButton(repo))

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

/**
 * The ahead/behind chip is the button: it already says what is out of step, so
 * pressing it is the obvious way to fix that. With nothing to move it stays out
 * of the way until the row is hovered — a fetch is still worth having then,
 * since ahead/behind only knows what the last fetch brought in.
 */
function syncButton(repo: RepoSummary): HTMLButtonElement {
  const busy = state.syncing.has(repo.id)
  const arrows = `${repo.behind ? `↓${repo.behind}` : ''}${repo.ahead ? `↑${repo.ahead}` : ''}`

  const button = el('button', 'repo-sync', busy ? '⟳' : arrows || 'sync')
  if (!arrows) button.classList.add('idle')
  if (busy) button.classList.add('busy')
  button.disabled = busy
  button.title = busy
    ? 'Syncing…'
    : `Sync with ${repo.tracking}${repo.behind ? ` — pull ${repo.behind}` : ''}${repo.ahead ? ` — push ${repo.ahead}` : ''}`
  button.addEventListener('click', event => {
    event.stopPropagation()
    void syncRepo(repo.id)
  })
  return button
}

async function syncRepo(repoId: string): Promise<void> {
  if (state.syncing.has(repoId)) return
  state.syncing.add(repoId)
  delete state.errors[repoId]
  renderSidebar()
  try {
    const result = await api.sync(repoId)
    if (!result.ok) state.errors[repoId] = result.error
  } catch (error) {
    state.errors[repoId] = String((error as Error).message ?? error)
  } finally {
    state.syncing.delete(repoId)
  }
  await hooks.refresh([repoId])
}

/**
 * One side of the index: a banded heading in the group's own colour, then the
 * files. The band is what you land on when scanning, so it carries the colour,
 * the name, the count and the bulk action.
 */
function stageGroup(repo: RepoSummary, entries: ChangeEntry[], staged: boolean): HTMLElement {
  const group = el('div', `group ${staged ? 'grp-staged' : 'grp-changed'}`)
  const head = el('div', 'sect')
  head.append(el('span', 'sect-dot'), el('span', 'label sect-title', staged ? 'Staged' : 'Changed'))
  head.append(el('span', 'count', String(entries.length)))
  head.append(
    actionButton(staged ? 'unstage all' : 'stage all', staged ? 'Unstage all' : 'Stage all', () =>
      bulk(repo, !staged)
    )
  )
  group.append(head, fileList(repo, entries, staged))
  return group
}

const dirOf = (filePath: string): string => {
  const cut = filePath.lastIndexOf('/')
  return cut === -1 ? '' : filePath.slice(0, cut)
}

/** Every row is a whole file: its name, then its directory, on one line. */
function fileList(repo: RepoSummary, entries: ChangeEntry[], staged: boolean): HTMLElement {
  const list = el('ul', 'files')
  for (const entry of entries) {
    const dir = dirOf(entry.path)
    list.append(fileRow(repo, entry, dir ? entry.path.slice(dir.length + 1) : entry.path, staged, dir))
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
  item.dataset.doc = docKey(doc)
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

