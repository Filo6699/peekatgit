// The http surface, exercised the way the client uses it: a real server process
// over a real workspace of two repositories.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import { cleanup, commitAll, git, makeRepo, tempDir, write } from './helpers.ts'

const ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url))
const START_TIMEOUT_MS = 20_000

let server: ChildProcess | undefined
let origin = ''
let workspace = ''
let alpha = ''
let beta = ''

/** Boots the CLI exactly as a user would, on a port the OS picks for us. */
function start(root: string, env: NodeJS.ProcessEnv): Promise<{ child: ChildProcess; origin: string }> {
  const child = spawn(process.execPath, [ENTRY, root, '--port', '0', '--no-open', '--foreground'], {
    env,
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  return new Promise((resolve, reject) => {
    let output = ''
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      reject(new Error(`server did not start in ${START_TIMEOUT_MS}ms; output:\n${output}`))
    }, START_TIMEOUT_MS)

    const inspect = (chunk: Buffer): void => {
      output += chunk.toString()
      const found = output.match(/http:\/\/127\.0\.0\.1:(\d+)/)
      if (!found) return
      clearTimeout(timer)
      resolve({ child, origin: found[0] })
    }

    child.stdout?.on('data', inspect)
    child.stderr?.on('data', inspect)
    child.on('exit', code => {
      clearTimeout(timer)
      reject(new Error(`server exited with ${code}; output:\n${output}`))
    })
  })
}

const get = (url: string): Promise<Response> => fetch(`${origin}${url}`)

const post = (url: string, body: unknown): Promise<Response> =>
  fetch(`${origin}${url}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  })

const json = async <T>(url: string): Promise<T> => {
  const response = await get(url)
  assert.equal(response.status, 200, `GET ${url}`)
  return (await response.json()) as T
}

before(async () => {
  workspace = await tempDir()
  alpha = await makeRepo(path.join(workspace, 'alpha'))
  beta = await makeRepo(path.join(workspace, 'beta'))

  await write(alpha, 'README.md', '# alpha\n')
  await write(alpha, 'src/main.ts', 'export const answer = 42\n')
  await commitAll(alpha, 'first')
  await write(beta, 'README.md', '# beta\n')
  await commitAll(beta, 'first')

  // Config and logs go into the throwaway workspace, never the real home dir.
  const started = await start(workspace, {
    ...process.env,
    XDG_CONFIG_HOME: path.join(workspace, '.config'),
    XDG_STATE_HOME: path.join(workspace, '.state'),
  })
  server = started.child
  origin = started.origin
})

after(async () => {
  server?.kill('SIGKILL')
  await cleanup()
})

type Workspace = { root: string; name: string; rootIsRepo: boolean; repos: { id: string; name: string; branch: string; staged: number; changes: number }[] }
type Entry = { name: string; path: string; dir: boolean }

describe('http api', () => {
  test('the workspace lists every repository one level down', async () => {
    const summary = await json<Workspace>('/api/workspace')
    assert.equal(summary.root, workspace)
    assert.equal(summary.rootIsRepo, false)
    assert.deepEqual(summary.repos.map(repo => repo.name), ['alpha', 'beta'])
    assert.equal(summary.repos[0]?.branch, 'main')
  })

  test('serves the app shell and 404s for anything else', async () => {
    const index = await get('/')
    assert.equal(index.status, 200)
    assert.equal(index.headers.get('content-type'), 'text/html; charset=utf-8')
    assert.match(await index.text(), /<title>/i)

    assert.equal((await get('/app.js')).status, 200)
    assert.equal((await get('/nope.js')).status, 404)
  })

  test('rejects requests for repositories it does not track', async () => {
    const response = await get(`/api/tree?repo=${encodeURIComponent('/etc')}`)
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /unknown repository/)

    assert.equal((await get('/api/tree')).status, 400)
  })

  test('refuses paths that leave the repository', async () => {
    const response = await get(`/api/file?repo=${encodeURIComponent(alpha)}&path=../beta/README.md`)
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /escapes repository/)
  })

  test('browses trees and reads files', async () => {
    const top = await json<Entry[]>(`/api/tree?repo=${encodeURIComponent(alpha)}`)
    assert.deepEqual(top.map(entry => entry.name), ['src', 'README.md'])

    const file = await json<{ content: string }>(
      `/api/file?repo=${encodeURIComponent(alpha)}&path=src/main.ts`
    )
    assert.equal(file.content, 'export const answer = 42\n')
  })

  test('the workspace tree spans the repos and names the owner of a file', async () => {
    const top = await json<Entry[]>('/api/ws/tree?path=')
    assert.deepEqual(top.map(entry => entry.name).sort(), ['alpha', 'beta'])

    const owned = await json<{ repo: string; repoPath: string; content: string }>(
      '/api/ws/file?path=alpha/README.md'
    )
    assert.equal(owned.repo, alpha)
    assert.equal(owned.repoPath, 'README.md')
    assert.equal(owned.content, '# alpha\n')

    assert.equal((await get('/api/ws/tree?path=../..')).status, 400)
  })

  test('stage, diff, commit and unstage move the same file through the api', async () => {
    await write(alpha, 'src/main.ts', 'export const answer = 43\n')

    const dirty = await json<Record<string, { staged: unknown[]; changes: { path: string }[] }>>(
      `/api/status?repo=${encodeURIComponent(alpha)}`
    )
    assert.deepEqual(dirty[alpha]?.changes.map(entry => entry.path), ['src/main.ts'])

    const patch = await get(`/api/diff?repo=${encodeURIComponent(alpha)}&path=src/main.ts`)
    assert.match(await patch.text(), /^\+export const answer = 43$/m)

    assert.deepEqual(await (await post('/api/stage', { repo: alpha, paths: ['src/main.ts'] })).json(), {
      ok: true,
    })
    const staged = await json<Record<string, { staged: { path: string }[]; changes: unknown[] }>>(
      `/api/status?repo=${encodeURIComponent(alpha)}`
    )
    assert.deepEqual(staged[alpha]?.staged.map(entry => entry.path), ['src/main.ts'])

    assert.deepEqual(await (await post('/api/unstage', { repo: alpha, paths: ['src/main.ts'] })).json(), {
      ok: true,
    })
    assert.deepEqual(await (await post('/api/stage', { repo: alpha, paths: [] })).json(), { ok: true })

    assert.deepEqual(await (await post('/api/commit', { repo: alpha, message: 'bump' })).json(), {
      ok: true,
    })
    assert.equal((await git(alpha, 'log', '-1', '--pretty=%s')).trim(), 'bump')

    const clean = await json<Record<string, { staged: unknown[]; changes: unknown[] }>>(
      `/api/status?repo=${encodeURIComponent(alpha)}`
    )
    assert.deepEqual(clean[alpha], { staged: [], changes: [] })
  })

  test('a failing git command comes back as an error, not a crash', async () => {
    const empty = await (await post('/api/commit', { repo: beta, message: '   ' })).json()
    assert.equal((empty as { ok: boolean }).ok, false)

    const nothing = await (await post('/api/commit', { repo: beta, message: 'nothing to do' })).json()
    assert.equal((nothing as { ok: boolean }).ok, false)
    assert.match((nothing as { error: string }).error, /nothing to commit/i)

    const discard = await (await post('/api/discard', { repo: beta, paths: [] })).json()
    assert.equal((discard as { ok: boolean }).ok, false)
  })

  test('hiding a repo is remembered and skips its git reads', async () => {
    assert.deepEqual(await (await post('/api/prefs', { repo: beta, hidden: true })).json(), { ok: true })

    const summary = await json<Workspace>('/api/workspace')
    const hidden = summary.repos.find(repo => repo.id === beta)
    assert.equal((hidden as unknown as { hidden: boolean }).hidden, true)
    assert.equal(hidden?.branch, '', 'a hidden repo costs no git calls')

    await post('/api/prefs', { repo: beta, hidden: false })
    assert.equal((await json<Workspace>('/api/workspace')).repos.find(r => r.id === beta)?.branch, 'main')
  })

  test('worktrees are listed and can be pinned into the sidebar', async () => {
    // Two levels down: deeper than the scan looks, so it only appears once pinned.
    const extra = path.join(workspace, 'wt', 'alpha-feature')
    await git(alpha, 'worktree', 'add', '-q', '-b', 'feature', extra)

    const trees = await json<{ path: string; known: boolean; current: boolean }[]>(
      `/api/worktrees?repo=${encodeURIComponent(alpha)}`
    )
    const feature = trees.find(tree => tree.path === extra)
    assert.ok(feature, 'the new worktree shows up')

    const added = await (await post('/api/repos/add', { path: extra })).json()
    assert.equal((added as { ok: boolean }).ok, true)
    assert.ok((await json<Workspace>('/api/workspace')).repos.some(repo => repo.id === extra))

    await post('/api/repos/remove', { repo: extra })
    assert.equal((await json<Workspace>('/api/workspace')).repos.some(repo => repo.id === extra), false)
  })

  test('the event stream opens and reports a change', async () => {
    const controller = new AbortController()
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal })
    assert.equal(response.status, 200)
    assert.match(response.headers.get('content-type') ?? '', /text\/event-stream/)

    const reader = response.body!.getReader()
    const first = new TextDecoder().decode((await reader.read()).value)
    assert.match(first, /retry: 1000/)

    await post('/api/stage', { repo: alpha, paths: [] })
    const message = new TextDecoder().decode((await reader.read()).value)
    assert.match(message, /^data: /m)
    assert.ok(JSON.parse(message.replace(/^data: /, '').trim()).repos.includes(alpha))

    controller.abort()
  })
})
