import type { ChangeEvent } from '../shared/types.ts'
import { api } from './api.ts'
import { byId } from './dom.ts'
import { refreshTrees, renderSidebar } from './sidebar.ts'
import { docRepo, hooks, state, visibleRepos } from './state.ts'
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
async function refresh(touched?: string[]): Promise<void> {
  state.workspace = await api.workspace()
  document.title = `${state.workspace.name} — PeekAtGit`
  ui.workspaceName.textContent = state.workspace.name

  const hiddenCount = state.workspace.repos.filter(repo => repo.hidden).length
  ui.repoCount.textContent = `${state.workspace.repos.length - hiddenCount} repos`
  ui.hiddenToggle.hidden = hiddenCount === 0
  ui.hiddenToggle.textContent = state.showHidden ? `hide ${hiddenCount} hidden` : `show ${hiddenCount} hidden`

  const wanted = visibleRepos()
    .filter(repo => !repo.hidden && !state.collapsed.has(repo.id))
    .map(repo => repo.id)
  state.statuses = await api.status(wanted)

  renderSidebar()

  const changed = touched ?? state.workspace.repos.map(repo => repo.id)
  await refreshTrees(changed)
  const owner = docRepo(state.doc)
  if (state.doc && (!owner || changed.includes(owner))) await refreshDoc()
}

hooks.refresh = refresh
hooks.open = async doc => {
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
  source.addEventListener('open', () => ui.pulse.classList.add('live'))
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
    void refresh(repos)
  })
}

await refresh()
subscribe()
