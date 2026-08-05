// The live layer. Two cheap mechanisms instead of one expensive one:
//
//   * a recursive watcher for the few repos the user is actually looking at,
//     so edits show up instantly;
//   * a slow status poll for everything else, so a `git commit` in another
//     terminal still lands in the sidebar.
//
// Watching every repo recursively would mean an inotify handle per directory
// across the whole workspace, which is exactly the load we are avoiding.

import { watch } from 'node:fs/promises'
import path from 'node:path'
import type { ServerResponse } from 'node:http'
import type { ChangeEvent } from '../shared/types.ts'
import { pollSignature } from './git.ts'
import { invalidate, scan, visibleRepoIds, workspaceRoot } from './workspace.ts'

const MAX_WATCHERS = 3
const POLL_MS = 2500
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

export const isWatched = (repoId: string): boolean => watchers.has(repoId)

async function watchRepo(repoId: string, controller: AbortController): Promise<void> {
  try {
    for await (const event of watch(repoId, { recursive: true, signal: controller.signal })) {
      const file = event.filename ?? ''
      if (file.startsWith('.git/') || file.startsWith(`.git${path.sep}`)) {
        // Skip git's internal churn, but do react to index / HEAD flips.
        if (/\.git[\\/](index|HEAD|MERGE_MSG)$/.test(file)) notify(repoId)
        continue
      }
      notify(repoId)
    }
  } catch {
    // Aborted, or the platform refused a recursive watch — polling still covers it.
    watchers.delete(repoId)
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
