// Shapes crossing the wire between server and browser.

/** Single letter from `git status --porcelain`: M, A, D, R, C, U or ? for untracked. */
export type StatusCode = 'M' | 'A' | 'D' | 'R' | 'C' | 'U' | 'T' | '?'

export type ChangeEntry = {
  path: string
  status: StatusCode
  /** Original path for renames/copies. */
  from?: string | null
  untracked?: boolean
}

export type StatusReport = {
  staged: ChangeEntry[]
  changes: ChangeEntry[]
}

/** A repository is identified by its absolute working-tree path. */
export type RepoSummary = {
  id: string
  name: string
  /** Shown under the name when two repos share a basename. */
  qualifier: string
  branch: string
  tracking: string
  ahead: number
  behind: number
  staged: number
  changes: number
  /** True when this checkout is a linked worktree (`.git` is a file). */
  isWorktree: boolean
  worktrees: number
  hidden: boolean
  order: number
  /** Added by hand (e.g. a worktree outside the workspace) rather than found by the scan. */
  pinned: boolean
  /** Set when the repo could not be read. */
  error?: string
}

export type Workspace = {
  root: string
  name: string
  /** True when the workspace root is itself a repository. */
  rootIsRepo: boolean
  repos: RepoSummary[]
}

export type Worktree = {
  path: string
  branch: string
  head: string
  /** True for the checkout we are looking at. */
  current: boolean
  /** True when this worktree is already in the repo list. */
  known: boolean
}

export type TreeEntry = {
  name: string
  path: string
  dir: boolean
  ignored: boolean
  /** Set in the workspace tree when this directory is one of the repositories. */
  repo?: boolean
}

export type FilePayload = {
  path: string
  size: number
  content?: string
  binary?: boolean
  tooBig?: boolean
  /** Set for workspace files that live inside a known repository. */
  repo?: string
  repoPath?: string
}

export type MutationResult = { ok: true } | { ok: false; error: string }

/** SSE payload: which repositories changed. */
export type ChangeEvent = { repos: string[] }
