// The live layer. Two cheap mechanisms instead of one expensive one:
//
//   * a watcher for the few repos the user is actually looking at, so edits
//     show up instantly;
//   * a slow status poll for everything else, so a `git commit` in another
//     terminal still lands in the sidebar.
//
// Watching every repo recursively would mean an inotify handle per directory
// across the whole workspace, which is exactly the load we are avoiding.

import { watch as watchDirectory } from 'node:fs'
import { readdir, watch } from 'node:fs/promises'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { ChangeEvent } from '../shared/types.ts'
import { pollSignature } from './git.ts'
import { invalidate, scan, visibleRepoIds, workspaceRoot } from './workspace.ts'

const MAX_WATCHERS = 3
const POLL_MS = 2500
/**
 * Never worth an inotify handle: build output and dependency trees are large,
 * churn constantly, and nothing in them is a change the sidebar should report.
 * `target` alone is most of what a rust checkout weighs.
 */
const UNWATCHED = new Set([
  'node_modules', 'vendor', 'target', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.venv', 'venv', '__pycache__', '.gradle', '.dart_tool', '.cache',
])
/** Repos checked per tick, so a workspace of sixty does not spawn sixty gits at once. */
const POLL_BATCH = 8

const clients = new Set<ServerResponse>()
const watchers = new Map<string, AbortController>()
const signatures = new Map<string, string>()
const pending = new Set<string>()

let flushTimer: NodeJS.Timeout | undefined

export function addClient(res: ServerResponse): void {
  clients.add(res)
}

export function removeClient(res: ServerResponse): void {
  clients.delete(res)
}

/** Queues a change notice; bursts of filesystem events collapse into one message. */
export function notify(repoId: string): void {
  invalidate(repoId)
  pending.add(repoId)
  clearTimeout(flushTimer)
  flushTimer = setTimeout(flush, 120)
}

function flush(): void {
  if (!pending.size || !clients.size) {
    pending.clear()
    return
  }
  const payload: ChangeEvent = { repos: [...pending] }
  pending.clear()
  // Every one of these makes the client re-read the workspace; a storm of them
  // is the difference between "live" and "unusable", so it is worth counting.
  if (process.env.PEEKATGIT_TRACE === '1') console.log(`          push  ${payload.repos.join(' ')}`)
  const message = `data: ${JSON.stringify(payload)}\n\n`
  for (const client of clients) client.write(message)
}

/** Puts a repo under instant watch, evicting the least recently focused one. */
export function focus(repoId: string): void {
  if (watchers.has(repoId)) {
    const existing = watchers.get(repoId)!
    watchers.delete(repoId)
    watchers.set(repoId, existing) // refresh recency
    return
  }
  while (watchers.size >= MAX_WATCHERS) {
    const [oldest, controller] = watchers.entries().next().value!
    controller.abort()
    watchers.delete(oldest)
  }
  const controller = new AbortController()
  watchers.set(repoId, controller)
  void watchRepo(repoId, controller)
}

/**
 * Watches a checkout by hand: one handle per directory, build output skipped,
 * and the walk spread across ticks by the readdir it already awaits.
 *
 * Node's own recursive watch is the obvious alternative and the reason this
 * exists: on Linux it walks the entire tree in one go — `target`, `node_modules`
 * and all — which cost half a second of blocked event loop and twenty thousand
 * handles on one repository here. Every request in flight waited for it.
 */
async function watchRepo(repoId: string, controller: AbortController): Promise<void> {
  const watched = new Set<string>()
  // git's own directory is watched flat: the index and HEAD are worth hearing
  // about, the loose objects churning under them are not.
  watchDir(repoId, path.join(repoId, '.git'), controller, watched)
  await walk(repoId, repoId, controller, watched)
}

async function walk(repoId: string, dir: string, controller: AbortController, watched: Set<string>): Promise<void> {
  const name = path.basename(dir)
  if (controller.signal.aborted || watched.has(dir) || name === '.git' || UNWATCHED.has(name)) return

  let entries
  try {
    // Reading first is also how a file tells us it is not a directory: only
    // directories get a handle, so an edited file never earns one.
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return // vanished mid-walk, a file, or not ours to read
  }

  watchDir(repoId, dir, controller, watched)
  for (const entry of entries) {
    if (entry.isDirectory()) await walk(repoId, path.join(dir, entry.name), controller, watched)
  }
}

function watchDir(repoId: string, dir: string, controller: AbortController, watched: Set<string>): void {
  if (watched.has(dir)) return
  watched.add(dir)
  try {
    const handle = watchDirectory(dir, { signal: controller.signal }, (_event, name) => {
      const inGit = dir.endsWith(`${path.sep}.git`)
      // git writes constantly; only the files that mean "the index moved" count.
      if (inGit && !/^(index|HEAD|MERGE_MSG)$/.test(String(name ?? ''))) return
      notify(repoId)
      // A new directory only becomes visible through its parent, so this is
      // where a fresh `src/feature/` picks up a watcher of its own.
      if (!inGit && name) void walk(repoId, path.join(dir, String(name)), controller, watched)
    })
    handle.on('error', () => handle.close())
  } catch {
    // Unreadable or already gone; the poll loop still covers this repo.
  }
}

let cursor = 0

/** Slow round-robin sweep over everything the watchers do not cover. */
async function poll(): Promise<void> {
  const ids = (await visibleRepoIds()).filter(id => !watchers.has(id))
  if (!ids.length) return
  if (cursor >= ids.length) cursor = 0
  const batch = ids.slice(cursor, cursor + POLL_BATCH)
  cursor = cursor + POLL_BATCH >= ids.length ? 0 : cursor + POLL_BATCH

  for (const id of batch) {
    try {
      const signature = await pollSignature(id)
      if (signatures.get(id) !== signature) {
        if (signatures.has(id)) notify(id)
        signatures.set(id, signature)
      }
    } catch {
      // Repo vanished; the next rescan will drop it.
    }
  }
}

/**
 * Repos appearing or disappearing at the top level need a rescan, not a status
 * read. The notify id is the workspace root, which is only a repo id when the
 * root is itself a checkout — either way the client re-reads the summary.
 */
async function watchWorkspaceRoot(): Promise<void> {
  const root = workspaceRoot()
  let timer: NodeJS.Timeout | undefined
  try {
    for await (const _event of watch(root)) {
      clearTimeout(timer)
      timer = setTimeout(() => {
        void scan().then(() => notify(root))
      }, 300)
    }
  } catch {
    // Not fatal: the poll loop keeps existing repos fresh.
  }
}

export function startLive(): void {
  const timer = setInterval(() => void poll(), POLL_MS)
  timer.unref?.()
  void poll()
  void watchWorkspaceRoot()
}
