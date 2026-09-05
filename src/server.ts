#!/usr/bin/env node
// PeekAtGit — a tiny git viewer. No runtime dependencies; runs on node >=22.18 or bun.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { MutationResult, RepoGraph, StatusReport } from './shared/types.ts'
import * as repo from './server/git.ts'
import * as workspace from './server/workspace.ts'
import * as live from './server/watch.ts'
import { openInBrowser, openWindow } from './server/window.ts'
import { detach, isDetachedChild, logPath, reportReady } from './server/daemon.ts'
import { configPath, lastWorkspace, rememberWorkspace } from './server/config.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(HERE, '..', 'public')

// ---------------------------------------------------------------- cli args
let target = ''
let port = 4141
let mode: 'window' | 'browser' | 'none' = 'window'
let background = true

for (let i = 2; i < process.argv.length; i++) {
  const arg = process.argv[i]!
  if (arg === '--port' || arg === '-p') port = Number(process.argv[++i])
  else if (arg === '--no-open') mode = 'none'
  else if (arg === '--browser') mode = 'browser'
  else if (arg === '--foreground' || arg === '-f') background = false
  else if (arg === '--help' || arg === '-h') {
    console.log(
      [
        'usage: peekatgit [workspace-or-repo-path] [options]',
        '',
        '  with no path, reopens the workspace you opened last (or the current',
        '  directory the first time round)',
        '',
        '  --port <n>    listen on this port instead of 4141',
        '  --browser     open a browser tab instead of an app window',
        '  --no-open     just serve; open it yourself',
        '  --foreground  stay attached to this terminal instead of detaching',
        '',
        `  logs of the background process: ${logPath}`,
        `  per-repository preferences:     ${configPath}`,
      ].join('\n')
    )
    process.exit(0)
  } else target = path.resolve(arg)
}

// No path given: pick up where we left off, falling back to the current
// directory the first time (or once the remembered one is gone).
if (!target) target = (await lastWorkspace()) ?? process.cwd()

// Everything below this line runs in the detached process; the launcher exits
// inside detach() as soon as the server reports its url.
if (background && !isDetachedChild) await detach()

try {
  await workspace.init(target)
  await rememberWorkspace(workspace.workspaceRoot())
} catch (error) {
  console.error(`peekatgit: ${(error as Error).message}`)
  process.exit(1)
}

// ------------------------------------------------------------------ http
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.map': 'application/json',
  '.svg': 'image/svg+xml',
}

function send(res: ServerResponse, code: number, payload: string | Buffer, type = 'application/json'): void {
  res.writeHead(code, { 'content-type': type, 'cache-control': 'no-store' })
  res.end(payload)
}

const json = (res: ServerResponse, data: unknown, code = 200) => send(res, code, JSON.stringify(data), 'application/json')

async function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (!chunks.length) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<string, unknown>
}

const stringList = (value: unknown): string[] => (Array.isArray(value) ? (value as string[]).filter(Boolean) : [])

/** Status for several repos in one round trip — the sidebar shows them all at once. */
async function statusFor(ids: string[]): Promise<Record<string, StatusReport>> {
  const known = ids.filter(id => workspace.knownRepo(id))
  const entries = await Promise.all(
    known.map(async id => {
      try {
        return [id, await repo.status(id)] as const
      } catch {
        // Repo disappeared between the summary and this call.
        return [id, { staged: [], changes: [] }] as const
      }
    })
  )
  return Object.fromEntries(entries)
}

/**
 * The graph tab draws every repository at once, so it asks for them all in one
 * request. A repo that cannot be read comes back as an empty column with a
 * reason on it rather than failing the whole screen.
 */
async function graphFor(ids: string[], limit: number): Promise<RepoGraph[]> {
  const known = ids.filter(id => workspace.knownRepo(id))
  return Promise.all(
    known.map(async id => {
      try {
        return { repo: id, commits: await repo.graph(id, limit) }
      } catch (error) {
        return { repo: id, commits: [], error: repo.gitError(error) }
      }
    })
  )
}

async function mutate(route: string, payload: Record<string, unknown>): Promise<MutationResult> {
  const target = workspace.requireRepo(String(payload.repo ?? ''))
  const paths = stringList(payload.paths)
  paths.forEach(relative => repo.resolveSafe(target, relative))

  try {
    if (route === '/api/stage') {
      await repo.git(target, paths.length ? ['add', '--', ...paths] : ['add', '-A'])
    } else if (route === '/api/unstage') {
      const args = paths.length ? paths : ['.']
      if (await repo.hasHead(target)) await repo.git(target, ['reset', '-q', 'HEAD', '--', ...args])
      else await repo.git(target, ['rm', '--cached', '-r', '-q', '--', ...args])
    } else if (route === '/api/discard') {
      if (!paths.length) throw new Error('discard requires explicit paths')
      await repo.git(target, ['checkout', '--', ...paths])
    } else if (route === '/api/commit') {
      const message = String(payload.message ?? '').trim()
      if (!message) throw new Error('commit message is empty')
      await repo.git(target, ['commit', '-m', message])
    }
  } catch (error) {
    return { ok: false, error: repo.gitError(error) }
  }
  live.notify(target)
  return { ok: true }
}

// Timing for when the tool feels slow and nobody can say which half is to blame.
// Off by default; PEEKATGIT_TRACE=1 puts a line per request in the log.
const TRACE = process.env.PEEKATGIT_TRACE === '1'

function trace(req: IncomingMessage, res: ServerResponse, url: URL): void {
  if (!TRACE) return
  const started = process.hrtime.bigint()
  res.on('finish', () => {
    const ms = Number(process.hrtime.bigint() - started) / 1e6
    const detail = url.searchParams.get('path') ?? url.searchParams.getAll('repo').join(' ')
    console.log(`${ms.toFixed(1).padStart(8)}ms  ${req.method} ${url.pathname} ${detail}`)
  })
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  trace(req, res, url)
  const query = url.searchParams
  const repoOf = () => workspace.requireRepo(query.get('repo'))

  try {
    switch (url.pathname) {
      case '/api/workspace':
        if (query.get('fresh') === '1') {
          await workspace.scan()
          for (const id of workspace.allRepoIds()) workspace.invalidate(id)
        }
        return json(res, { ...(await workspace.describe(query.has('partial') ? query.getAll('repo') : undefined)), trace: TRACE })

      case '/api/status':
        return json(res, await statusFor(query.getAll('repo')))

      case '/api/diff': {
        const text = await repo.diff(
          repoOf(),
          query.get('path') ?? '',
          query.get('staged') === '1',
          query.get('untracked') === '1'
        )
        return send(res, 200, text, 'text/plain; charset=utf-8')
      }

      case '/api/graph': {
        const asked = Number(query.get('limit'))
        const limit = Math.min(2000, Math.max(10, Number.isFinite(asked) && asked > 0 ? asked : 120))
        return json(res, await graphFor(query.getAll('repo'), limit))
      }

      case '/api/worktrees':
        return json(res, await workspace.worktreesOf(repoOf()))

      case '/api/events':
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-cache',
          connection: 'keep-alive',
        })
        res.write('retry: 1000\n\n')
        live.addClient(res)
        req.on('close', () => live.removeClient(res))
        return
    }

    if (req.method === 'POST') {
      // The client's own stopwatch, sent as plain text so a beacon can carry it.
      // Server timings alone cannot tell a slow read from a slow repaint.
      if (url.pathname === '/api/trace') {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(chunk as Buffer)
        if (TRACE) console.log(`   client  ${Buffer.concat(chunks).toString('utf8')}`)
        return send(res, 200, '', 'text/plain')
      }

      const payload = await readBody(req)

      switch (url.pathname) {
        case '/api/stage':
        case '/api/unstage':
        case '/api/discard':
        case '/api/commit':
          return json(res, await mutate(url.pathname, payload))

        case '/api/sync': {
          const target = workspace.requireRepo(String(payload.repo ?? ''))
          try {
            const moved = await repo.sync(target)
            live.notify(target)
            return json(res, { ok: true, ...moved })
          } catch (error) {
            live.notify(target)
            return json(res, { ok: false, error: repo.gitError(error) })
          }
        }

        case '/api/focus':
          live.focus(workspace.requireRepo(String(payload.repo ?? '')))
          return json(res, { ok: true })

        case '/api/prefs': {
          const patch: { hidden?: boolean; order?: number } = {}
          if (typeof payload.hidden === 'boolean') patch.hidden = payload.hidden
          if (typeof payload.order === 'number') patch.order = payload.order
          await workspace.setPrefs(String(payload.repo ?? ''), patch)
          return json(res, { ok: true })
        }

        case '/api/reorder':
          await workspace.reorder(stringList(payload.ids))
          return json(res, { ok: true })

        case '/api/repos/add': {
          const added = await workspace.pinRepo(String(payload.path ?? ''))
          return json(res, { ok: true, repo: added.id })
        }

        case '/api/repos/remove':
          await workspace.unpinRepo(String(payload.repo ?? ''))
          return json(res, { ok: true })
      }
    }

    const relative = url.pathname === '/' ? 'index.html' : decodeURIComponent(url.pathname.slice(1))
    const file = path.join(PUBLIC, relative)
    // The separator matters: without it a sibling directory whose name merely
    // starts with "public" would pass for one of our own assets.
    if (!file.startsWith(PUBLIC + path.sep) || !existsSync(file)) return send(res, 404, 'not found', 'text/plain')
    return send(res, 200, await readFile(file), MIME[path.extname(file)] ?? 'application/octet-stream')
  } catch (error) {
    json(res, { error: String((error as Error).message ?? error) }, 400)
  }
})

function ready(): void {
  const address = server.address()
  const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : port}`
  const count = workspace.allRepoIds().length
  const where = `${path.basename(workspace.workspaceRoot())}, ${count} repo${count === 1 ? '' : 's'}`

  if (mode === 'window') {
    // Closing the window quits the tool; that is what a window means.
    const opened = openWindow(url, () => process.exit(0))
    if (!opened) {
      console.log('peekatgit: no chromium-family browser found, opening a tab instead')
      mode = 'browser'
    }
  }
  if (mode === 'browser') openInBrowser(url)

  // The browser needs a moment to start and ask; the summary every workspace
  // opens with is the slowest read there is, so it gets built in that moment
  // rather than after the page has already asked for it.
  void workspace.describe()

  console.log(`PeekAtGit → ${url}  (${where})`)
  // The launcher prints this for us and then lets go of the terminal.
  reportReady({ url, where })
}

// One listener per attempt, not one per attempt still armed from the last:
// `listen` used to hand the success callback in again on every retry, so a
// third attempt opened three windows.
function listen(candidate: number, attempt = 0): void {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attempt < 20) return listen(candidate + 1, attempt + 1)
    throw error
  })
  server.listen(candidate, '127.0.0.1')
}

server.once('listening', ready)


live.startLive()
listen(port)
