// Everything that shells out to git. One repository per call, addressed by its
// working-tree path — there is no ambient "current repo" here.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readFile, readdir, stat } from 'node:fs/promises'
import path from 'node:path'
import type { ChangeEntry, FilePayload, StatusCode, StatusReport, TreeEntry, Worktree } from '../shared/types.ts'

const exec = promisify(execFile)

type ExecFailure = { stdout?: string; stderr?: string; message?: string }

export async function git(repo: string, args: string[]): Promise<string> {
  const { stdout } = await exec('git', args, { cwd: repo, maxBuffer: 64 * 1024 * 1024, encoding: 'utf8' })
  return stdout
}

/** git exits non-zero for plenty of benign cases (no HEAD yet, `diff --no-index`). */
export async function gitSoft(repo: string, args: string[]): Promise<string> {
  try {
    return await git(repo, args)
  } catch (error) {
    return (error as ExecFailure).stdout ?? ''
  }
}

export function gitError(error: unknown): string {
  const failure = error as ExecFailure
  return (failure.stderr || failure.stdout || failure.message || String(error)).trim()
}

/** Resolves the working-tree root, or null when the path is not a checkout. */
export async function toplevel(dir: string): Promise<string | null> {
  try {
    const root = (await git(dir, ['rev-parse', '--show-toplevel'])).trim()
    return root || null
  } catch {
    return null
  }
}

export async function head(repo: string): Promise<{ branch: string; tracking: string; ahead: number; behind: number }> {
  const branch = (await gitSoft(repo, ['rev-parse', '--abbrev-ref', 'HEAD'])).trim() || 'HEAD'
  const tracking = (await gitSoft(repo, ['rev-parse', '--abbrev-ref', '@{upstream}'])).trim()
  let ahead = 0
  let behind = 0
  if (tracking) {
    const counts = (await gitSoft(repo, ['rev-list', '--left-right', '--count', `${tracking}...HEAD`])).trim()
    const [b, a] = counts.split(/\s+/).map(Number)
    behind = b || 0
    ahead = a || 0
  }
  return { branch, tracking, ahead, behind }
}

export const rawStatus = (repo: string): Promise<string> =>
  gitSoft(repo, ['status', '--porcelain=v1', '-z', '--untracked-files=all'])

/**
 * One call whose output changes whenever anything the sidebar shows changes —
 * `-b` folds branch and ahead/behind into the same string. Compared, not parsed.
 */
export const pollSignature = (repo: string): Promise<string> =>
  gitSoft(repo, ['status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'])

/** `git status --porcelain=v1 -z`: NUL-separated records; renames carry a second path. */
export function parseStatus(raw: string): StatusReport {
  const records = raw.split('\0')
  const staged: ChangeEntry[] = []
  const changes: ChangeEntry[] = []

  for (let i = 0; i < records.length; i++) {
    const record = records[i]!
    if (!record) continue
    const index = record[0] as StatusCode | ' '
    const worktree = record[1] as StatusCode | ' '
    const file = record.slice(3)
    const from = index === 'R' || index === 'C' ? records[++i] ?? null : null

    if (index === '?' && worktree === '?') {
      changes.push({ path: file, status: '?', untracked: true })
      continue
    }
    if (index !== ' ') staged.push({ path: file, status: index, from })
    if (worktree !== ' ') changes.push({ path: file, status: worktree, from })
  }

  const byPath = (a: ChangeEntry, b: ChangeEntry) => a.path.localeCompare(b.path)
  return { staged: staged.sort(byPath), changes: changes.sort(byPath) }
}

export const status = async (repo: string): Promise<StatusReport> => parseStatus(await rawStatus(repo))

export async function worktrees(repo: string): Promise<Omit<Worktree, 'known'>[]> {
  const raw = await gitSoft(repo, ['worktree', 'list', '--porcelain'])
  const here = await toplevel(repo)
  const result: Omit<Worktree, 'known'>[] = []
  let current: { path?: string; head?: string; branch?: string } = {}

  for (const line of raw.split('\n')) {
    if (line.startsWith('worktree ')) current = { path: line.slice(9) }
    else if (line.startsWith('HEAD ')) current.head = line.slice(5, 12)
    else if (line.startsWith('branch ')) current.branch = line.slice(7).replace('refs/heads/', '')
    else if (line.startsWith('detached')) current.branch = 'detached'
    else if (line === '' && current.path) {
      result.push({
        path: current.path,
        head: current.head ?? '',
        branch: current.branch ?? 'HEAD',
        current: current.path === here,
      })
      current = {}
    }
  }
  return result
}

/** Every path from the client is repo-relative and must stay inside the repo. */
export function resolveSafe(repo: string, relative: string): string {
  const abs = path.resolve(repo, relative)
  if (abs !== repo && !abs.startsWith(repo + path.sep)) throw new Error('path escapes repository')
  return abs
}

export async function diff(repo: string, file: string, staged: boolean, untracked: boolean): Promise<string> {
  resolveSafe(repo, file)
  if (untracked) return gitSoft(repo, ['diff', '--no-index', '--no-color', '/dev/null', file])
  const args = ['diff', '--no-color']
  if (staged) args.push('--cached')
  return gitSoft(repo, [...args, '--', file])
}

export async function listDir(repo: string, relative: string): Promise<TreeEntry[]> {
  const abs = resolveSafe(repo, relative)
  const entries = (await readdir(abs, { withFileTypes: true })).filter(entry => entry.name !== '.git')
  const ignored = await ignoredNames(repo, relative, entries.map(entry => entry.name))

  return entries
    .map(entry => ({
      name: entry.name,
      path: relative ? path.posix.join(relative, entry.name) : entry.name,
      dir: entry.isDirectory(),
      ignored: ignored.has(entry.name),
    }))
    .sort((a, b) => (a.dir === b.dir ? a.name.localeCompare(b.name) : a.dir ? -1 : 1))
}

/** One `check-ignore` per directory listing keeps ignored entries dimmed cheaply. */
export async function ignoredNames(repo: string, relative: string, names: string[]): Promise<Set<string>> {
  if (!names.length) return new Set()
  const stdout = await new Promise<string>(resolve => {
    const child = execFile('git', ['check-ignore', '--stdin'], { cwd: repo }, (_error, out) => resolve(out || ''))
    child.stdin?.end(names.map(name => (relative ? path.posix.join(relative, name) : name)).join('\n'))
  })
  return new Set(stdout.split('\n').filter(Boolean).map(entry => path.posix.basename(entry)))
}

const MAX_FILE = 2 * 1024 * 1024

export async function fileContent(repo: string, relative: string): Promise<FilePayload> {
  const abs = resolveSafe(repo, relative)
  const info = await stat(abs)
  if (info.size > MAX_FILE) return { path: relative, size: info.size, tooBig: true }
  const buffer = await readFile(abs)
  if (buffer.subarray(0, 8000).includes(0)) return { path: relative, size: info.size, binary: true }
  return { path: relative, size: info.size, content: buffer.toString('utf8') }
}

export async function hasHead(repo: string): Promise<boolean> {
  return Boolean((await gitSoft(repo, ['rev-parse', '--verify', 'HEAD'])).trim())
}
