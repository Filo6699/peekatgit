// Per-repository preferences that belong to PeekAtGit rather than to git:
// visibility and sort order. Stored once per workspace under XDG config.

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

export type RepoPrefs = {
  hidden?: boolean
  order?: number
  /** Registered by hand (a worktree, or a repo outside the scanned depth). */
  pinned?: boolean
}

type WorkspacePrefs = { repos: Record<string, RepoPrefs> }
type ConfigFile = { workspaces: Record<string, WorkspacePrefs> }

const CONFIG_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'), 'peekatgit')
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json')

let cache: ConfigFile | null = null
let writing: Promise<void> = Promise.resolve()

async function load(): Promise<ConfigFile> {
  if (cache) return cache
  try {
    cache = JSON.parse(await readFile(CONFIG_FILE, 'utf8')) as ConfigFile
  } catch {
    cache = { workspaces: {} }
  }
  if (!cache.workspaces) cache.workspaces = {}
  return cache
}

async function persist(): Promise<void> {
  const snapshot = JSON.stringify(cache, null, 2)
  // Serialise writes so rapid reorder clicks cannot interleave.
  writing = writing.then(async () => {
    await mkdir(CONFIG_DIR, { recursive: true })
    await writeFile(CONFIG_FILE, snapshot + '\n')
  })
  return writing
}

export async function allPrefs(workspace: string): Promise<Record<string, RepoPrefs>> {
  const config = await load()
  return config.workspaces[workspace]?.repos ?? {}
}

export async function prefsFor(workspace: string, repoId: string): Promise<RepoPrefs> {
  return (await allPrefs(workspace))[repoId] ?? {}
}

export async function updatePrefs(workspace: string, repoId: string, patch: RepoPrefs): Promise<void> {
  const config = await load()
  const entry = (config.workspaces[workspace] ??= { repos: {} })
  entry.repos[repoId] = { ...entry.repos[repoId], ...patch }
  await persist()
}

export async function forgetRepo(workspace: string, repoId: string): Promise<void> {
  const config = await load()
  delete config.workspaces[workspace]?.repos[repoId]
  await persist()
}

export const configPath = CONFIG_FILE
