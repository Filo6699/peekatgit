import type { ChangeEvent } from '../shared/types.ts'
import { api } from './api.ts'
import { byId } from './dom.ts'
import { initGraph, refreshGraph } from './graph.ts'
import { showPane } from './panes.ts'
import { renderSidebar } from './sidebar.ts'
import { docRepo, hooks, state, visibleRepos } from './state.ts'
import { refreshQueue } from './refresh.ts'
import { mark } from './trace.ts'
import { openDoc, refreshDoc } from './viewer.ts'

const ui = {
  workspaceName: byId('wsName'),
  repoCount: byId('repoCount'),
  hiddenToggle: byId<HTMLButtonElement>('toggleHidden'),
  pulse: byId('pulse'),
}

/**
 * Pulls the workspace summary, then the change lists for the repos that are
 * actually unfolded. `touched` names the repos whose file trees and open
 * document need re-reading too.
 */
async function refreshNow(touched?: string[]): Promise<void> {
  const done = mark('refresh')
  state.workspace = await api.workspace(touched)
  for (const [id, report] of Object.entries(state.workspace.statuses ?? {})) {
    if (JSON.stringify(report) !== JSON.stringify(state.statuses[id])) state.statuses[id] = report
  }
  const known = new Set(state.workspace.repos.map(repo => repo.id))
  for (const id of Object.keys(state.statuses)) if (!known.has(id)) delete state.statuses[id]
  document.title = `${state.workspace.name} — PeekAtGit`
  ui.workspaceName.textContent = state.workspace.name

  const hiddenCount = state.workspace.repos.filter(repo => repo.hidden).length
  ui.repoCount.textContent = `${state.workspace.repos.length - hiddenCount} repos`
  ui.hiddenToggle.hidden = hiddenCount === 0
  ui.hiddenToggle.textContent = state.showHidden ? `hide ${hiddenCount} hidden` : `show ${hiddenCount} hidden`

  const wanted = visibleRepos()
    .filter(repo => !repo.hidden && !state.statuses[repo.id])
    .map(repo => repo.id)
  Object.assign(state.statuses, await api.status(wanted))

  renderSidebar()

  const changed = touched ?? state.workspace.repos.map(repo => repo.id)
  await refreshGraph(changed) // a no-op unless the graph is the tab that is up
  const owner = docRepo(state.doc)
  if (state.tab === 'changes' && state.doc && (!owner || changed.includes(owner))) await refreshDoc()
  done(changed.join(' '))
}

const refresh = refreshQueue(async repos => {
  try { await refreshNow(repos) }
  catch (error) { showError(error) }
})
function showError(error: unknown): void {
  const host = byId('appError')
  host.textContent = (error as Error).message ?? String(error)
  host.hidden = false
}
hooks.refresh = refresh
hooks.paint = renderSidebar
hooks.open = async doc => {
  showPane('viewer')
  await openDoc(doc)
  renderSidebar() // repaint the active-row highlight
}

ui.hiddenToggle.addEventListener('click', () => {
  state.showHidden = !state.showHidden
  void refresh([])
})

// ------------------------------------------------------------ sidebar width
const sidebar = byId('sidebar').parentElement as HTMLElement
const grip = byId('grip')
const savedWidth = Number(localStorage.getItem('peekatgit.width'))
if (savedWidth >= 220) sidebar.style.width = `${savedWidth}px`

grip.addEventListener('pointerdown', event => {
  event.preventDefault()
  grip.classList.add('dragging')
  grip.setPointerCapture(event.pointerId)

  const onMove = (move: PointerEvent) => {
    const width = Math.min(720, Math.max(220, move.clientX))
    sidebar.style.width = `${width}px`
  }
  const onUp = () => {
    grip.classList.remove('dragging')
    grip.removeEventListener('pointermove', onMove)
    localStorage.setItem('peekatgit.width', String(sidebar.offsetWidth))
  }
  grip.addEventListener('pointermove', onMove)
  grip.addEventListener('pointerup', onUp, { once: true })
})

// The server pushes the ids of repos that changed; everything else stays put.
function subscribe(): void {
  const source = new EventSource('/api/events')
  let connected = false
  source.addEventListener('open', () => {
    ui.pulse.classList.add('live')
    if (connected) void refresh()
    connected = true
  })
  source.addEventListener('error', () => ui.pulse.classList.remove('live'))
  source.addEventListener('message', event => {
    ui.pulse.classList.add('beat')
    setTimeout(() => ui.pulse.classList.remove('beat'), 250)
    let repos: string[] | undefined
    try {
      repos = (JSON.parse(event.data as string) as ChangeEvent).repos
    } catch {
      repos = undefined
    }
    if (document.hidden) return
    void refresh(repos)
  })
}

document.addEventListener('visibilitychange', () => { if (!document.hidden) void refresh() })
window.addEventListener('unhandledrejection', event => { event.preventDefault(); showError(event.reason) })
initGraph()
await refresh()
// The remembered tab may be the one that owns the right-hand pane.
if (state.tab === 'graph') showPane('graph')
subscribe()
