#!/usr/bin/env node
// PeekAtGit — a tiny git viewer. No runtime dependencies; runs on node >=22.18 or bun.
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { MutationResult, StatusReport } from './shared/types.ts'
import * as repo from './server/git.ts'
import * as workspace from './server/workspace.ts'
import * as live from './server/watch.ts'
import { openInBrowser, openWindow } from './server/window.ts'
import { detach, isDetachedChild, logPath, reportReady } from './server/daemon.ts'
import { configPath } from './server/config.ts'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const PUBLIC = path.resolve(HERE, '..', 'public')

// ---------------------------------------------------------------- cli args
let target = process.cwd()
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

// Everything below this line runs in the detached process; the launcher exits
// inside detach() as soon as the server reports its url.
if (background && !isDetachedChild) await detach()

try {
  await workspace.init(target)
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

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost')
  const query = url.searchParams
  const repoOf = () => workspace.requireRepo(query.get('repo'))

  try {
    switch (url.pathname) {
      case '/api/workspace':
        return json(res, await workspace.describe())

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

      case '/api/tree':
        return json(res, await repo.listDir(repoOf(), query.get('path') ?? ''))

      case '/api/file':
        return json(res, await repo.fileContent(repoOf(), query.get('path') ?? ''))

      case '/api/worktrees':
        return json(res, await workspace.worktreesOf(repoOf()))

      case '/api/ws/tree':
        return json(res, await workspace.listWorkspaceDir(query.get('path') ?? ''))

      case '/api/ws/file': {
        const relative = query.get('path') ?? ''
        const { base, owner } = workspace.workspaceFile(relative)
        const payload = await repo.fileContent(base, relative)
        return json(res, owner ? { ...payload, repo: owner.repo, repoPath: owner.relative } : payload)
      }

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
      const payload = await readBody(req)
      switch (url.pathname) {
        case '/api/stage':
        case '/api/unstage':
        case '/api/discard':
        case '/api/commit':
          return json(res, await mutate(url.pathname, payload))

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

function listen(candidate: number, attempt = 0): void {
  server.once('error', (error: NodeJS.ErrnoException) => {
    if (error.code === 'EADDRINUSE' && attempt < 20) return listen(candidate + 1, attempt + 1)
    throw error
  })
  server.listen(candidate, '127.0.0.1', () => {
    const address = server.address()
    const url = `http://127.0.0.1:${typeof address === 'object' && address ? address.port : candidate}`
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

    console.log(`PeekAtGit → ${url}  (${where})`)
    // The launcher prints this for us and then lets go of the terminal.
    reportReady({ url, where })
  })
}

live.startLive()
listen(port)
