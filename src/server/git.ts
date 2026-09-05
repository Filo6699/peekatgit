// Everything that shells out to git. One repository per call, addressed by its
// working-tree path — there is no ambient "current repo" here.

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { readdir, readFile, stat } from 'node:fs/promises'
import path from 'node:path'
import { limitConcurrency } from './queue.ts'
import type {
  ChangeEntry,
  GraphCommit,
  StatusCode,
  StatusReport,
  Worktree,
} from '../shared/types.ts'

const exec = promisify(execFile)
const localGit = limitConcurrency(4)
const remoteGit = limitConcurrency(2)

type ExecFailure = { stdout?: string; stderr?: string; message?: string }

export async function git(repo: string, args: string[], maxBuffer = 8 * 1024 * 1024): Promise<string> {
  const { stdout } = await localGit(() => exec('git', args, { cwd: repo, maxBuffer, encoding: 'utf8', timeout: 30_000 }))
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

export type Head = { branch: string; tracking: string; ahead: number; behind: number }

/**
 * `## main...origin/main [ahead 1, behind 2]` — the header `--branch` puts in
 * front of a porcelain status. Everything the sidebar says about a branch is in
 * that one line, which is why the summary no longer spends three `rev-parse`s
 * and a `rev-list` per repository to learn the same thing.
 */
export function parseBranchHeader(line: string): Head {
  let rest = line.slice(3) // drop the leading "## "
  let ahead = 0
  let behind = 0

  const bracket = rest.lastIndexOf(' [')
  if (bracket !== -1 && rest.endsWith(']')) {
    for (const part of rest.slice(bracket + 2, -1).split(', ')) {
      if (part.startsWith('ahead ')) ahead = Number(part.slice(6)) || 0
      else if (part.startsWith('behind ')) behind = Number(part.slice(7)) || 0
    }
    rest = rest.slice(0, bracket)
  }

  // A repository with no commits yet still names the branch it will be on.
  rest = rest.replace(/^No commits yet on /, '')
  if (rest.endsWith(' (no branch)')) return { branch: 'HEAD', tracking: '', ahead: 0, behind: 0 }

  const sep = rest.indexOf('...')
  return {
    branch: (sep === -1 ? rest : rest.slice(0, sep)) || 'HEAD',
    tracking: sep === -1 ? '' : rest.slice(sep + 3),
    ahead,
    behind,
  }
}

/** Branch, upstream, ahead/behind and both change lists, from a single git. */
export async function headAndStatus(repo: string): Promise<{ head: Head; report: StatusReport }> {
  const raw = await pollSignature(repo)
  const cut = raw.indexOf('\0')
  const header = cut === -1 ? raw : raw.slice(0, cut)
  return {
    head: parseBranchHeader(header),
    report: parseStatus(cut === -1 ? '' : raw.slice(cut + 1)),
  }
}

export const rawStatus = (repo: string): Promise<string> =>
  git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '--untracked-files=all'])

/**
 * One call whose output changes whenever anything the sidebar shows changes —
 * `-b` folds branch and ahead/behind into the same string. Compared, not parsed.
 */
export const pollSignature = (repo: string): Promise<string> =>
  git(repo, ['--no-optional-locks', 'status', '--porcelain=v1', '-z', '-b', '--untracked-files=all'])

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

/**
 * How many worktrees a checkout has, counted off the filesystem: linked ones
 * each get a directory under `.git/worktrees`, and the main one is the +1. The
 * sidebar only wants the number, and `git worktree list` is a process too many
 * when the summary asks every repository at once.
 */
export async function worktreeCount(repo: string): Promise<number> {
  try {
    const dotGit = path.join(repo, '.git')
    let gitDir = dotGit
    if ((await stat(dotGit)).isFile()) {
      // A linked worktree points at `<main>/.git/worktrees/<name>`; anything
      // else pointing elsewhere (a submodule) is left to git and its own count.
      const target = path.resolve(repo, (await readFile(dotGit, 'utf8')).replace(/^gitdir:\s*/, '').trim())
      if (path.basename(path.dirname(target)) !== 'worktrees') return 1
      gitDir = path.dirname(path.dirname(target))
    }
    return (await readdir(path.join(gitDir, 'worktrees'))).length + 1
  } catch {
    return 1 // no linked worktrees, or nothing we can read
  }
}

// ----------------------------------------------------------------- graph
// One `git log` per repository, every branch in it, newest first. The lanes are
// drawn in the browser — all the server owes it is the parent links.

/** Unit separator between fields, record separator between commits: both safe in a subject. */
const GRAPH_FORMAT = '%H%x1f%P%x1f%D%x1f%an%x1f%at%x1f%s%x1e'

export async function graph(repo: string, limit: number): Promise<GraphCommit[]> {
  const raw = await gitSoft(repo, [
    'log',
    '--all',
    '--date-order',
    `--max-count=${limit}`,
    `--pretty=format:${GRAPH_FORMAT}`,
  ])
  return parseGraph(raw)
}

/** `%D` reads "HEAD -> main, origin/main, tag: v1"; the arrow and the prefix go. */
export function parseRefs(field: string): string[] {
  const refs: string[] = []
  for (const raw of field.split(', ')) {
    const ref = raw.trim()
    if (!ref) continue
    if (ref.startsWith('HEAD -> ')) refs.push('HEAD', ref.slice(8))
    else if (ref.startsWith('tag: ')) refs.push(ref.slice(5))
    else refs.push(ref)
  }
  return refs
}

export function parseGraph(raw: string): GraphCommit[] {
  const commits: GraphCommit[] = []
  for (const record of raw.split('\x1e')) {
    // `format:` joins records with a newline, so every one but the first leads with it.
    const line = record.replace(/^\n/, '')
    if (!line) continue
    const [hash = '', parents = '', refs = '', author = '', time = '', subject = ''] = line.split('\x1f')
    if (!hash) continue
    commits.push({
      hash,
      parents: parents.split(' ').filter(Boolean),
      refs: parseRefs(refs),
      author,
      time: Number(time) || 0,
      subject,
    })
  }
  return commits
}

/** Every path from the client is repo-relative and must stay inside the repo. */
export function resolveSafe(repo: string, relative: string): string {
  const abs = path.resolve(repo, relative)
  if (abs !== repo && !abs.startsWith(repo + path.sep)) throw new Error('path escapes repository')
  return abs
}

export async function diff(repo: string, file: string, staged: boolean, untracked: boolean): Promise<string> {
  const absolute = resolveSafe(repo, file)
  const args = ['diff', '--no-color', '--no-ext-diff', '--no-textconv']
  if (staged) args.push('--cached')
  if (untracked) args.push('--no-index', '--', '/dev/null', absolute)
  else args.push('--', file)
  try {
    return await git(repo, args, 4 * 1024 * 1024)
  } catch (error) {
    // --no-index uses exit 1 to report differences; other errors must reach the UI.
    const failure = error as ExecFailure & { code?: number | string }
    if (untracked && failure.code === 1 && failure.stdout && !failure.stderr) return failure.stdout
    if (failure.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER') throw new Error('Diff exceeds the 4 MB preview limit.')
    throw error
  }
}

// ---------------------------------------------------------------- sync
// Talking to a remote is the one thing here that can sit there waiting: a
// passphrase prompt, an https credential helper, a host key nobody has said yes
// to yet. None of that can be answered from a web page, so every prompt is
// turned into a failure the sidebar can show, and the whole thing is capped.

const REMOTE_TIMEOUT_MS = 120_000

const REMOTE_ENV = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: 'echo',
  SSH_ASKPASS: 'echo',
  GIT_SSH_COMMAND: 'ssh -oBatchMode=yes',
}

async function gitRemote(repo: string, args: string[]): Promise<string> {
  const { stdout } = await remoteGit(() => exec('git', args, {
    cwd: repo,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
    timeout: REMOTE_TIMEOUT_MS,
    env: { ...process.env, ...REMOTE_ENV },
  }))
  return stdout
}

const headOf = async (repo: string): Promise<Head> =>
  parseBranchHeader((await pollSignature(repo)).split('\0')[0] ?? '')

/**
 * One button for "catch up with the remote": fetch, take whatever arrived, then
 * hand over whatever is ours. Diverged branches are rebased rather than merged —
 * a merge commit is a decision, and a button should not be making it.
 */
export async function sync(repo: string): Promise<{ pulled: number; pushed: number }> {
  const start = await headOf(repo)
  if (!start.tracking) throw new Error('branch has no upstream to sync with')

  await gitRemote(repo, ['fetch', '--prune'])
  const fetched = await headOf(repo)

  // Already fetched above; merge/rebase against the upstream ref directly so we
  // do not go back over the network a second time.
  if (fetched.behind) {
    if (fetched.ahead) {
      try {
        await git(repo, ['rebase', '@{u}'])
      } catch (error) {
        // A conflicted rebase would leave the checkout mid-operation, and this
        // window has nowhere to resolve one. Put it back and say what happened.
        await gitSoft(repo, ['rebase', '--abort'])
        throw error
      }
    } else await git(repo, ['merge', '--ff-only', '@{u}'])
  }

  const merged = await headOf(repo)
  if (merged.ahead) await gitRemote(repo, ['push'])

  return { pulled: fetched.behind, pushed: merged.ahead }
}

export async function hasHead(repo: string): Promise<boolean> {
  return Boolean((await gitSoft(repo, ['rev-parse', '--verify', 'HEAD'])).trim())
}
