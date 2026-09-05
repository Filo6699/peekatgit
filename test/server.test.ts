// The http surface, exercised the way the client uses it: a real server process
// over a real workspace of two repositories.

import assert from 'node:assert/strict'
import { spawn, type ChildProcess } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { after, before, describe, test } from 'node:test'
import type { ChangeEvent } from '../src/shared/types.ts'
import { cleanup, commitAll, git, makeRepo, tempDir, write } from './helpers.ts'

const ENTRY = fileURLToPath(new URL('../src/server.ts', import.meta.url))
const START_TIMEOUT_MS = 20_000

let server: ChildProcess | undefined
let origin = ''
let workspace = ''
let alpha = ''
let beta = ''
/** A clone with a real (file://-less, plain path) remote, for the sync route. */
let gamma = ''
let remote = ''
let peer = ''

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

  // A bare remote and a second checkout of it, both outside the workspace so
  // the scan never sees them; `gamma` inside it is the one the sidebar drives.
  const away = await tempDir()
  remote = path.join(away, 'remote.git')
  await git(away, 'init', '--bare', '-q', '-b', 'main', 'remote.git')
  peer = await makeRepo(path.join(away, 'peer'))
  await write(peer, 'README.md', '# gamma\n')
  await commitAll(peer, 'first')
  await git(peer, 'remote', 'add', 'origin', remote)
  await git(peer, 'push', '-q', '-u', 'origin', 'main')

  await git(workspace, 'clone', '-q', remote, 'gamma')
  gamma = path.join(workspace, 'gamma')
  await git(gamma, 'config', 'user.name', 'PeekAtGit Test')
  await git(gamma, 'config', 'user.email', 'test@example.invalid')
  await git(gamma, 'config', 'commit.gpgsign', 'false')

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

describe('http api', () => {
  test('the workspace lists every repository one level down', async () => {
    const summary = await json<Workspace>('/api/workspace')
    assert.equal(summary.root, workspace)
    assert.equal(summary.rootIsRepo, false)
    assert.deepEqual(summary.repos.map(repo => repo.name), ['alpha', 'beta', 'gamma'])
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
    const response = await get(`/api/diff?repo=${encodeURIComponent('/etc')}`)
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /unknown repository/)

    assert.equal((await get('/api/diff')).status, 400)
  })

  test('refuses paths that leave the repository', async () => {
    const response = await get(`/api/diff?repo=${encodeURIComponent(alpha)}&path=../beta/README.md`)
    assert.equal(response.status, 400)
    assert.match(((await response.json()) as { error: string }).error, /escapes repository/)
  })

  test('removed file browser and terminal routes return 404', async () => {
    for (const route of ['/api/tree', '/api/file', '/api/ws/tree', '/api/ws/file', '/api/term/stream']) {
      assert.equal((await get(route)).status, 404)
    }
    assert.equal((await post('/api/term/run', { command: 'echo removed' })).status, 404)
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

  test('sync pulls what the remote has and pushes what we have', async () => {
    // Both sides move: the remote gains a commit, we gain another. One press
    // has to fetch, rebase ours on top, and then hand ours over.
    await write(peer, 'THEIRS.md', 'from the remote\n')
    await commitAll(peer, 'theirs')
    await git(peer, 'push', '-q')

    await write(gamma, 'OURS.md', 'from here\n')
    await commitAll(gamma, 'ours')

    const result = await (await post('/api/sync', { repo: gamma })).json()
    assert.deepEqual(result, { ok: true, pulled: 1, pushed: 1 })

    const log = (await git(gamma, 'log', '--pretty=%s')).trim().split('\n')
    assert.deepEqual(log, ['ours', 'theirs', 'first'], 'ours sits on top of theirs')
    assert.equal((await git(remote, 'log', '-1', '--pretty=%s')).trim(), 'ours', 'and the remote has it')

    const summary = await json<Workspace>('/api/workspace')
    const synced = summary.repos.find(repo => repo.id === gamma) as unknown as { ahead: number; behind: number }
    assert.deepEqual({ ahead: synced.ahead, behind: synced.behind }, { ahead: 0, behind: 0 })

    // Nothing to sync with is a plain error, the same as any other failed git.
    const orphan = await (await post('/api/sync', { repo: alpha })).json()
    assert.equal((orphan as { ok: boolean }).ok, false)
    assert.match((orphan as { error: string }).error, /upstream/i)
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

  test('a focused repo reports edits from the filesystem, but not from its build output', async () => {
    await post('/api/focus', { repo: beta })

    const controller = new AbortController()
    const response = await fetch(`${origin}/api/events`, { signal: controller.signal })
    const reader = response.body!.getReader()
    await reader.read() // the retry preamble

    /** Resolves with the repos named by the next event, or null if none arrives. */
    const nextEvent = async (): Promise<string[] | null> => {
      const timer = setTimeout(() => controller.abort(), 4000)
      try {
        const chunk = new TextDecoder().decode((await reader.read()).value)
        return (JSON.parse(chunk.replace(/^data: /, '').trim()) as ChangeEvent).repos
      } catch {
        return null
      } finally {
        clearTimeout(timer)
      }
    }

    // A directory created after the watch began has to earn a watcher of its own,
    // which is the case the old recursive watch got for free and this one must not.
    await write(beta, 'src/deep/nested.ts', 'export const x = 1\n')
    assert.ok((await nextEvent())?.includes(beta), 'a new file in a new directory is a change')

    await write(beta, 'src/deep/nested.ts', 'export const x = 2\n')
    assert.ok((await nextEvent())?.includes(beta), 'and so is editing it afterwards')

    // Dependency trees are the reason this watcher walks by hand: they are large,
    // they churn, and nothing in them belongs in the sidebar. The directory
    // appearing is a change to the root, which is watched; what happens inside it
    // afterwards is not.
    await write(beta, 'node_modules/pkg/index.js', 'module.exports = 1\n')
    assert.ok((await nextEvent())?.includes(beta), 'node_modules appearing is seen once')

    await write(beta, 'node_modules/pkg/index.js', 'module.exports = 2\n')
    assert.equal(await nextEvent(), null, 'but nothing inside it is watched')

    controller.abort()
  })
})
