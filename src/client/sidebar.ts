import type { ChangeEntry, RepoSummary, StatusCode } from '../shared/types.ts'
import { api } from './api.ts'
import { actionButton, byId, el } from './dom.ts'
import { graphCount, openGraph, scrollToRepo } from './graph.ts'
import { operate } from './operations.ts'
import { showPane } from './panes.ts'
import { docKey, hooks, matches, repoColor, setTab, state, visibleRepos, type Doc } from './state.ts'

const host = byId('sidebar')
const tabsHost = byId('tabs')
const sections = new Map<string, { key: string; report: unknown; node: HTMLElement }>()
const limits = new Map<string, number>()
const commitBoxes = new Map<string, { root: HTMLElement; textarea: HTMLTextAreaElement; button: HTMLButtonElement }>()
let tabsKey = ''
const MARK: Record<StatusCode, [string, string, string]> = {
  M: ['M', 'g-mod', 'Modified'], A: ['A', 'g-new', 'Added'], '?': ['U', 'g-new', 'Untracked'],
  D: ['D', 'g-del', 'Deleted'], R: ['R', 'g-move', 'Renamed'], C: ['C', 'g-move', 'Copied'],
  U: ['!', 'g-warn', 'Conflict'], T: ['T', 'g-mod', 'Type changed'],
}

export function renderSidebar(): void {
  renderTabs()
  for (const row of host.querySelectorAll<HTMLElement>('[data-doc]')) {
    row.classList.toggle('active', row.dataset.doc === docKey(state.doc))
    row.setAttribute('aria-selected', String(row.dataset.doc === docKey(state.doc)))
  }
  if (state.tab === 'graph') return host.replaceChildren(graphList())
  const repos = visibleRepos().filter(repo => {
    if (state.onlyDirty && !repo.staged && !repo.changes && !repo.error && !state.errors[repo.id]) return false
    const report = state.statuses[repo.id]
    return matches(repo) || [...(report?.staged ?? []), ...(report?.changes ?? [])].some(entry => matches(repo, entry.path))
  })
  repos.sort((a, b) => Number(Boolean(b.staged || b.changes)) - Number(Boolean(a.staged || a.changes)))
  const known = new Set(state.workspace.repos.map(repo => repo.id))
  for (const id of sections.keys()) if (!known.has(id)) { sections.delete(id); commitBoxes.delete(id) }
  const active = document.activeElement as HTMLElement | null
  const nodes = repos.map(cachedSection)
  if (!nodes.length) nodes.push(el('div', 'empty', state.filter ? 'No matching repositories or files.' : 'Working trees are clean.'))
  nodes.forEach((node, index) => {
    if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null)
  })
  while (host.children.length > nodes.length) host.lastElementChild!.remove()
  if (active?.isConnected && document.activeElement !== active) active.focus({ preventScroll: true })
}

function cachedSection(repo: RepoSummary): HTMLElement {
  const key = JSON.stringify([repo, state.filter, state.errors[repo.id], state.collapsed.has(repo.id),
    state.busy.get(repo.id), state.worktreesOpen.has(repo.id), state.worktrees[repo.id], limits.get(repo.id + ':true'), limits.get(repo.id + ':false')])
  const previous = sections.get(repo.id)
  const report = state.statuses[repo.id]
  if (previous?.key === key && previous.report === report) return previous.node
  const node = repoSection(repo)
  sections.set(repo.id, { key, report, node })
  return node
}

function renderTabs(): void {
  const total = visibleRepos().filter(repo => !repo.hidden).reduce((sum, repo) => sum + repo.staged + repo.changes, 0)
  const key = `${state.tab}:${total}`
  if (tabsKey === key) return
  tabsKey = key
  tabsHost.replaceChildren(...(['changes', 'graph'] as const).map(tab => {
    const button = el('button', `tab${state.tab === tab ? ' on' : ''}`, tab === 'changes' ? 'Changes' : 'History')
    button.setAttribute('aria-pressed', String(state.tab === tab))
    if (tab === 'changes') button.append(el('span', 'tab-n', String(total)))
    button.addEventListener('click', () => {
      setTab(tab)
      if (tab === 'graph') openGraph()
      else { showPane('viewer'); void hooks.refresh(state.doc ? [state.doc.repo] : []) }
      renderSidebar()
    })
    return button
  }))
}

function graphList(): HTMLElement {
  const list = el('div', 'glist')
  list.append(el('div', 'label list-label', 'Repositories'))
  for (const repo of visibleRepos().filter(repo => !repo.hidden && matches(repo))) {
    const row = el('button', 'row glist-row')
    row.style.setProperty('--id', repoColor(repo.id))
    row.title = repo.id
    row.append(el('span', 'gut gdot-cell', '●'), el('span', 'repo-name', repo.name), el('span', 'spacer'), el('span', 'count', `${graphCount(repo.id)}`))
    row.addEventListener('click', () => scrollToRepo(repo.id))
    list.append(row)
  }
  return list
}

function repoSection(repo: RepoSummary): HTMLElement {
  const section = el('section', `repo${repo.hidden ? ' is-hidden' : ''}${repo.staged || repo.changes ? ' dirty' : ' clean'}`)
  section.dataset.repo = repo.id
  section.style.setProperty('--id', repoColor(repo.id))
  section.append(repoHeader(repo))
  if (repo.hidden || state.collapsed.has(repo.id)) return section
  const report = state.statuses[repo.id]
  const staged = (report?.staged ?? []).filter(entry => matches(repo, entry.path))
  const changes = (report?.changes ?? []).filter(entry => matches(repo, entry.path))
  const body = el('div', 'repo-body')
  if (repo.error || state.errors[repo.id]) {
    const error = el('div', 'err', repo.error || state.errors[repo.id])
    error.setAttribute('role', 'alert')
    body.append(error)
  }
  if (state.worktreesOpen.has(repo.id)) body.append(worktreeList(repo))
  if (staged.length) body.append(stageGroup(repo, staged, true))
  if (repo.staged) body.append(commitBox(repo))
  if (changes.length) body.append(stageGroup(repo, changes, false))
  if (body.childElementCount) section.append(body)
  return section
}

function repoHeader(repo: RepoSummary): HTMLElement {
  const head = el('div', 'repo-header')
  const row = el('div', 'repo-row')
  const toggle = el('button', 'repo-toggle')
  toggle.title = repo.id
  toggle.setAttribute('aria-expanded', String(!state.collapsed.has(repo.id)))
  toggle.append(el('span', 'chevron', state.collapsed.has(repo.id) ? '›' : '⌄'), el('span', 'repo-name', repo.name))
  if (repo.qualifier) toggle.append(el('span', 'repo-qual', repo.qualifier))
  toggle.addEventListener('click', () => {
    if (state.collapsed.has(repo.id)) state.collapsed.delete(repo.id)
    else state.collapsed.add(repo.id)
    renderSidebar()
  })
  row.append(toggle, el('span', `repo-count${repo.staged || repo.changes ? '' : ' is-clean'}`, repo.staged || repo.changes ? String(repo.staged + repo.changes) : 'Clean'))
  if (repo.isWorktree) row.append(el('span', 'repo-flag', 'worktree'))
  const menu = el('details', 'repo-menu')
  const trigger = el('summary', '', '···')
  trigger.title = 'Repository options'
  trigger.setAttribute('aria-label', `Options for ${repo.name}`)
  const actions = el('div', 'repo-options')
  actions.append(
    actionButton('Move up', 'Move repository up', () => move(repo.id, -1)),
    actionButton('Move down', 'Move repository down', () => move(repo.id, 1)),
    actionButton(repo.hidden ? 'Show repository' : 'Hide repository', 'Change visibility', async () => {
      const result = await api.prefs(repo.id, { hidden: !repo.hidden })
      if (!result.ok) throw new Error(result.error)
      await hooks.refresh()
    }))
  if (repo.pinned) actions.append(actionButton('Remove from workspace', 'Remove pinned worktree', async () => {
    await api.removeRepo(repo.id); await hooks.refresh()
  }))
  menu.append(trigger, actions)
  row.append(menu)
  const info = el('div', 'repo-info')
  info.append(el('span', 'branch-icon', '⑂'), el('span', 'repo-branch', repo.branch || 'Unavailable'))
  if (repo.worktrees > 1) info.append(actionButton(`${repo.worktrees} worktrees`, 'Show linked worktrees', () => toggleWorktrees(repo.id)))
  info.append(el('span', 'spacer'))
  if (state.busy.has(repo.id)) info.append(el('span', 'operation-state', state.busy.get(repo.id)))
  else if (repo.tracking) {
    const counts = `${repo.behind ? ` ↓${repo.behind}` : ''}${repo.ahead ? ` ↑${repo.ahead}` : ''}`
    info.append(actionButton(`Sync${counts}`, `Fetch ${repo.tracking}, integrate upstream (rebase if diverged), then push`, () =>
      operate(repo.id, 'Syncing…', () => api.sync(repo.id))))
  }
  head.append(row, info)
  return head
}

function stageGroup(repo: RepoSummary, entries: ChangeEntry[], staged: boolean): HTMLElement {
  const group = el('div', `group ${staged ? 'grp-staged' : 'grp-changed'}`)
  const head = el('div', 'sect')
  head.append(el('span', 'sect-dot'), el('span', 'label', staged ? 'Staged changes' : 'Working tree'), el('span', 'count', String(entries.length)), el('span', 'spacer'))
  const bulk = actionButton(staged ? 'Unstage all' : 'Stage all', staged ? 'Unstage every file in this repository' : 'Stage every change in this repository', () =>
    operate(repo.id, staged ? 'Unstaging…' : 'Staging…', () => staged ? api.unstage(repo.id, []) : api.stage(repo.id, [])))
  bulk.disabled = state.busy.has(repo.id)
  head.append(bulk)
  const list = el('ul', 'files')
  const key = repo.id + ':' + staged
  const limit = limits.get(key) ?? 200
  for (const entry of entries.slice(0, limit)) list.append(fileRow(repo, entry, staged))
  group.append(head, list)
  if (entries.length > limit) group.append(actionButton(`Show next ${Math.min(200, entries.length - limit)} files (${entries.length - limit} remaining)`, 'Load more changes', () => {
    limits.set(key, limit + 200); renderSidebar()
  }))
  return group
}

function fileRow(repo: RepoSummary, entry: ChangeEntry, staged: boolean): HTMLLIElement {
  const doc: Doc = { kind: 'diff', repo: repo.id, path: entry.path, staged, untracked: Boolean(entry.untracked), from: entry.from }
  const [mark, tone, label] = MARK[entry.status] ?? ['·', '', entry.status]
  const item = el('li', 'row file')
  item.dataset.doc = docKey(doc)
  item.classList.toggle('active', docKey(doc) === docKey(state.doc))
  item.title = `${entry.path} — ${label}${entry.from ? ` (from ${entry.from})` : ''}`
  const open = el('button', 'file-open')
  open.setAttribute('aria-label', `${entry.path}, ${staged ? 'staged' : 'working tree'}, ${label}`)
  const cut = entry.path.lastIndexOf('/')
  open.append(el('span', `gut ${tone}`, mark), el('span', 'fname', entry.path.slice(cut + 1)))
  if (cut !== -1) open.append(el('span', 'fdir', entry.path.slice(0, cut)))
  open.addEventListener('click', () => void hooks.open(doc))
  // Keep programmatic row activation useful for navigation and browser checks.
  item.addEventListener('click', event => { if (event.target === item) void hooks.open(doc) })
  const actions = el('span', 'actions')
  const paths = entry.from ? [entry.path, entry.from] : [entry.path]
  const stage = actionButton(staged ? '−' : '+', staged ? 'Unstage file' : 'Stage file', () =>
    operate(repo.id, staged ? 'Unstaging…' : 'Staging…', () => staged ? api.unstage(repo.id, paths) : api.stage(repo.id, paths)))
  stage.disabled = state.busy.has(repo.id)
  actions.append(stage)
  if (!staged && !entry.untracked) {
    const discard = actionButton('↶', 'Discard working-tree changes', async () => {
      if (confirm(`Discard working-tree changes in ${entry.path}? This cannot be undone.`)) {
        await operate(repo.id, 'Discarding…', () => api.discard(repo.id, [entry.path]))
      }
    })
    discard.disabled = state.busy.has(repo.id)
    discard.classList.add('danger')
    actions.append(discard)
  }
  item.append(open, actions)
  return item
}

function commitBox(repo: RepoSummary): HTMLElement {
  let box = commitBoxes.get(repo.id)
  if (!box) {
    const root = el('div', 'commit')
    const textarea = el('textarea')
    textarea.rows = 2
    textarea.placeholder = 'Describe your changes…'
    textarea.setAttribute('aria-label', `Commit message for ${repo.name}`)
    const button = el('button', 'primary', 'Commit staged')
    const update = () => { button.disabled = !textarea.value.trim() || !state.statuses[repo.id]?.staged.length || state.busy.has(repo.id) }
    const commit = () => {
      if (button.disabled) return
      const message = textarea.value.trim()
      void operate(repo.id, 'Committing…', () => api.commit(repo.id, message), () => { textarea.value = '' })
    }
    textarea.addEventListener('input', update)
    textarea.addEventListener('keydown', event => {
      if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') { event.preventDefault(); commit() }
    })
    button.addEventListener('click', commit)
    const footer = el('div', 'commit-footer')
    footer.append(el('span', 'hint', 'Ctrl / ⌘ + Enter'), button)
    root.append(textarea, footer)
    box = { root, textarea, button }
    commitBoxes.set(repo.id, box)
  }
  box.button.disabled = !box.textarea.value.trim() || !state.statuses[repo.id]?.staged.length || state.busy.has(repo.id)
  box.button.textContent = state.busy.get(repo.id) === 'Committing…' ? 'Committing…' : `Commit ${repo.staged} staged`
  return box.root
}

async function move(repo: string, delta: number): Promise<void> {
  const ids = state.workspace.repos.map(repo => repo.id)
  const from = ids.indexOf(repo), to = from + delta
  if (from < 0 || to < 0 || to >= ids.length) return
  ids.splice(to, 0, ...ids.splice(from, 1))
  await api.reorder(ids)
  await hooks.refresh()
}

async function toggleWorktrees(repo: string): Promise<void> {
  if (state.worktreesOpen.has(repo)) state.worktreesOpen.delete(repo)
  else {
    state.worktrees[repo] = await api.worktrees(repo)
    state.worktreesOpen.add(repo)
  }
  renderSidebar()
}

function worktreeList(repo: RepoSummary): HTMLElement {
  const list = el('ul', 'wt')
  for (const tree of state.worktrees[repo.id] ?? []) {
    const row = el('li', 'row')
    row.title = tree.path
    row.append(el('span', 'gut', tree.current ? '●' : '⑂'), el('span', 'wt-branch', tree.branch), el('span', 'spacer'))
    if (tree.current) row.append(el('span', 'hint', 'current'))
    else if (!tree.known) row.append(actionButton('Add', 'Pin this worktree', async () => {
      await api.addRepo(tree.path)
      state.worktrees[repo.id] = await api.worktrees(repo.id)
      await hooks.refresh()
    }))
    else row.append(actionButton('Show', 'Go to this worktree', () => {
      state.collapsed.delete(tree.path)
      renderSidebar()
      host.querySelector(`[data-repo="${CSS.escape(tree.path)}"]`)?.scrollIntoView({ block: 'nearest' })
    }))
    list.append(row)
  }
  return list
}
