import type { StatusReport, Workspace, Worktree } from '../shared/types.ts'

/** A selected change, in the index or working tree. */
export type Doc = { kind: 'diff'; repo: string; path: string; staged: boolean; untracked: boolean; from?: string | null }
export const docRepo = (doc: Doc | null): string | null => doc?.repo ?? null
export type Tab = 'changes' | 'graph'
const TAB_KEY = 'peekatgit.tab'
const savedTab = localStorage.getItem(TAB_KEY)

export const state = {
  /** Which sidebar tab is up — remembered, like the sidebar width and the dock. */
  tab: (savedTab === 'graph' ? savedTab : 'changes') as Tab,
  workspace: { root: '', name: '', rootIsRepo: false, repos: [] } as Workspace,
  statuses: {} as Record<string, StatusReport>,
  worktrees: {} as Record<string, Worktree[]>,
  errors: {} as Record<string, string>,
  doc: null as Doc | null,
  showHidden: false,
  /** Repos whose change lists are folded away. */
  collapsed: new Set<string>(),
  /** Repos with a sync in flight; their button is spoken for until it lands. */
  syncing: new Set<string>(),
  /** Repos whose worktree list is unfolded. */
  worktreesOpen: new Set<string>(),
}

export function setTab(tab: Tab): void {
  state.tab = tab
  localStorage.setItem(TAB_KEY, tab)
}

/** Wired up by app.ts; lets sidebar and viewer call each other without a cycle. */
export const hooks = {
  refresh: async (_repos?: string[]): Promise<void> => {},
  open: async (_doc: Doc): Promise<void> => {},
  /** Repaint the sidebar — for when something else learned what it shows. */
  paint: (): void => {},
}

export const docKey = (doc: Doc | null): string => {
  if (!doc) return ''
  return `${doc.repo} ${doc.kind}:${doc.kind === 'diff' && doc.staged ? 's' : 'w'}:${doc.path}`
}

/**
 * Every repository gets a colour it keeps: the spine down its block in the
 * sidebar, its name in the project tree, its name in the viewer header. Muted
 * enough that eight of them on screen still read as one interface.
 */
const IDENTITY = ['#d09a63', '#6fb0a6', '#ab8fc7', '#b9aa5f', '#7fa2d4', '#cd8496', '#94bd6c', '#c98d54']

export function repoColor(id: string): string {
  let hash = 0
  for (let index = 0; index < id.length; index++) hash = (hash * 31 + id.charCodeAt(index)) >>> 0
  return IDENTITY[hash % IDENTITY.length]!
}

export const STATUS_LABEL: Record<string, string> = {
  M: 'modified',
  A: 'added',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  U: 'conflicted',
  T: 'type changed',
  '?': 'untracked',
}

export const visibleRepos = () => state.workspace.repos.filter(repo => state.showHidden || !repo.hidden)

export const formatSize = (bytes: number): string =>
  bytes < 1024
    ? `${bytes} B`
    : bytes < 1024 * 1024
      ? `${(bytes / 1024).toFixed(1)} KB`
      : `${(bytes / 1024 / 1024).toFixed(1)} MB`
