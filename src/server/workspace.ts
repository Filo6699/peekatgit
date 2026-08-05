// The workspace: one directory that either is a repository, or contains
// repositories one level down. Worktrees registered by hand live here too.

import { readdir, stat } from 'node:fs/promises'
import { existsSync, statSync, type Dirent } from 'node:fs'
import path from 'node:path'
import type { RepoSummary, TreeEntry, Workspace, Worktree } from '../shared/types.ts'
import { allPrefs, forgetRepo, updatePrefs } from './config.ts'
import { head, ignoredNames, status, toplevel, worktrees as listWorktrees } from './git.ts'

export type RepoRecord = {
  id: string
  name: string
  isWorktree: boolean
  /** Registered by hand rather than found by the scan. */
  pinned: boolean
}

const SKIP_DIRS = new Set(['node_modules', 'vendor', 'target', 'dist', 'build'])

let root = ''
let rootIsRepo = false
const registry = new Map<string, RepoRecord>()

export const workspaceRoot = (): string => root
export const knownRepo = (id: string): RepoRecord | undefined => registry.get(id)

/** Throws unless the id is a repository we deliberately track. */
export function requireRepo(id: string | null): string {
  if (!id) throw new Error('missing repo')
  const record = registry.get(id)
  if (!record) throw new Error('unknown repository')
  return record.id
}

export async function init(target: string): Promise<void> {
  root = path.resolve(target)
  const asRepo = await toplevel(root)
  rootIsRepo = asRepo === root
  await scan()
  if (!registry.size) throw new Error(`no git repositories in ${root} (looked here and one level down)`)
}

/** Rebuilds the registry: the root if it is a repo, every repo one level down, plus pinned entries. */
export async function scan(): Promise<void> {
  const found = new Map<string, RepoRecord>()

  if (rootIsRepo) found.set(root, record(root))

  let entries: Dirent[] = []
  try {
    entries = await readdir(root, { withFileTypes: true })
  } catch {
    entries = []
  }

  for (const entry of entries) {
    const isDir = entry.isDirectory() || (entry.isSymbolicLink() && safeIsDir(path.join(root, entry.name)))
    if (!isDir || entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
    const candidate = path.join(root, entry.name)
    if (!existsSync(path.join(candidate, '.git'))) continue
    const top = await toplevel(candidate)
    if (top) found.set(top, record(top))
  }

  // Pinned repos (worktrees, or anything the user added) survive rescans.
  for (const [id, prefs] of Object.entries(await allPrefs(root))) {
    if (!prefs.pinned || found.has(id)) continue
    if (!existsSync(path.join(id, '.git'))) {
      await forgetRepo(root, id)
      continue
    }
    found.set(id, { ...record(id), pinned: true })
  }

  registry.clear()
  for (const [id, value] of found) registry.set(id, value)
  for (const id of facts.keys()) if (!registry.has(id)) facts.delete(id)
}

function record(repoPath: string): RepoRecord {
  return {
    id: repoPath,
    name: path.basename(repoPath),
    isWorktree: safeIsFile(path.join(repoPath, '.git')),
    pinned: false,
  }
}

const safeIsDir = (p: string): boolean => {
  try {
    return statSync(p).isDirectory()
  } catch {
    return false
  }
}

const safeIsFile = (p: string): boolean => {
  try {
    return statSync(p).isFile()
  } catch {
    return false
  }
}

/** Registers a repository outside the scan — used when opening a worktree. */
export async function pinRepo(target: string): Promise<RepoRecord> {
  const top = await toplevel(path.resolve(target))
  if (!top) throw new Error('not a git repository')
  await updatePrefs(root, top, { pinned: true })
  await scan()
  const added = registry.get(top)
  if (!added) throw new Error('could not register repository')
  return added
}

export async function unpinRepo(id: string): Promise<void> {
  await forgetRepo(root, id)
  await scan()
}

export async function setPrefs(id: string, patch: { hidden?: boolean; order?: number }): Promise<void> {
  requireRepo(id)
  await updatePrefs(root, id, patch)
}

export async function reorder(ids: string[]): Promise<void> {
  await Promise.all(ids.map((id, index) => (registry.has(id) ? updatePrefs(root, id, { order: index }) : null)))
}

/** The git-derived half of a summary — cached, because a refresh asks for every repo at once. */
type RepoFacts = Pick<
  RepoSummary,
  'branch' | 'tracking' | 'ahead' | 'behind' | 'staged' | 'changes' | 'worktrees' | 'error'
>

const facts = new Map<string, RepoFacts>()

/** Called by the live layer: this repo moved, so its facts must be re-read. */
export function invalidate(id: string): void {
  facts.delete(id)
}

async function factsFor(id: string): Promise<RepoFacts> {
  const cached = facts.get(id)
  if (cached) return cached
  try {
    const [info, report, trees] = await Promise.all([head(id), status(id), listWorktrees(id)])
    const fresh: RepoFacts = {
      ...info,
      staged: report.staged.length,
      changes: report.changes.length,
      worktrees: trees.length,
    }
    facts.set(id, fresh)
    return fresh
  } catch (error) {
    return {
      branch: '',
      tracking: '',
      ahead: 0,
      behind: 0,
      staged: 0,
      changes: 0,
      worktrees: 0,
      error: String((error as Error).message ?? error),
    }
  }
}

/** Full picture for the sidebar. Hidden repos skip the git calls entirely. */
export async function describe(): Promise<Workspace> {
  const prefs = await allPrefs(root)
  const records = [...registry.values()].sort((a, b) => a.name.localeCompare(b.name))
  const duplicated = new Set(
    records.map(r => r.name).filter((name, i, all) => all.indexOf(name) !== i)
  )

  const repos = await Promise.all(
    records.map(async (repo, index): Promise<RepoSummary> => {
      const own = prefs[repo.id] ?? {}
      const base: RepoSummary = {
        id: repo.id,
        name: repo.name,
        qualifier: duplicated.has(repo.name) ? path.dirname(repo.id).replace(root, '').replace(/^\//, '') || '/' : '',
        branch: '',
        tracking: '',
        ahead: 0,
        behind: 0,
        staged: 0,
        changes: 0,
        isWorktree: repo.isWorktree,
        worktrees: 0,
        hidden: Boolean(own.hidden),
        order: own.order ?? 1000 + index,
        pinned: repo.pinned,
      }
      if (base.hidden) return base
      return { ...base, ...(await factsFor(repo.id)) }
    })
  )

  repos.sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
  return { root, name: path.basename(root), rootIsRepo, repos }
}

// ------------------------------------------------------- the project tree
// The Files tab browses the workspace itself, not one repository at a time:
// the directories between repos are part of the project too.

export async function listWorkspaceDir(relative: string): Promise<TreeEntry[]> {
  const abs = path.resolve(root, relative)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes workspace')

  const entries = (await readdir(abs, { withFileTypes: true })).filter(entry => entry.name !== '.git')
  const owner = ownerOf(abs)
  const ignored = owner
    ? await ignoredNames(owner.repo, owner.relative, entries.map(entry => entry.name))
    : new Set<string>()

  return entries
    .map(entry => ({
      name: entry.name,
      path: relative ? path.posix.join(relative, entry.name) : entry.name,
      dir: entry.isDirectory(),
      ignored: ignored.has(entry.name),
      repo: registry.has(path.join(abs, entry.name)),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

/** The repository a path sits in, if any — the deepest one wins for nested worktrees. */
export function ownerOf(absPath: string): { repo: string; relative: string } | null {
  let best: string | null = null
  for (const id of registry.keys()) {
    if ((absPath === id || absPath.startsWith(id + path.sep)) && (!best || id.length > best.length)) best = id
  }
  return best ? { repo: best, relative: path.relative(best, absPath) } : null
}

export function workspaceFile(relative: string): { base: string; owner: ReturnType<typeof ownerOf> } {
  const abs = path.resolve(root, relative)
  if (abs !== root && !abs.startsWith(root + path.sep)) throw new Error('path escapes workspace')
  return { base: root, owner: ownerOf(abs) }
}

export async function worktreesOf(id: string): Promise<Worktree[]> {
  const repo = requireRepo(id)
  const trees = await listWorktrees(repo)
  return trees.map(tree => ({ ...tree, known: registry.has(tree.path) }))
}

/** Ids the live layer should keep an eye on. */
export async function visibleRepoIds(): Promise<string[]> {
  const prefs = await allPrefs(root)
  return [...registry.keys()].filter(id => !prefs[id]?.hidden)
}

export const allRepoIds = (): string[] => [...registry.keys()]

export async function repoExists(id: string): Promise<boolean> {
  try {
    return (await stat(id)).isDirectory()
  } catch {
    return false
  }
}
