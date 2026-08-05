// Shared scaffolding for the tests: throwaway workspaces on disk, with real
// repositories in them. Nothing here is mocked — the tool is a thin layer over
// `git`, so a fake git would only test the fake.

import { execFile } from 'node:child_process'
import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const exec = promisify(execFile)

export const git = async (cwd: string, ...args: string[]): Promise<string> =>
  (await exec('git', args, { cwd, encoding: 'utf8' })).stdout

const roots: string[] = []

/** An empty directory that is removed when the suite ends. */
export async function tempDir(): Promise<string> {
  // Through realpath: on macOS the temp dir is a symlink, and git always
  // reports the resolved path — the two have to agree for lookups by id.
  const dir = await realpath(await mkdtemp(path.join(tmpdir(), 'peekatgit-test-')))
  roots.push(dir)
  return dir
}

export async function cleanup(): Promise<void> {
  await Promise.all(roots.splice(0).map(dir => rm(dir, { recursive: true, force: true })))
}

/** A repository with its own identity, so committing works on a bare CI box. */
export async function makeRepo(dir: string): Promise<string> {
  await mkdir(dir, { recursive: true })
  await git(dir, 'init', '-q', '-b', 'main')
  await git(dir, 'config', 'user.name', 'PeekAtGit Test')
  await git(dir, 'config', 'user.email', 'test@example.invalid')
  await git(dir, 'config', 'commit.gpgsign', 'false')
  return dir
}

export async function write(repo: string, relative: string, content: string): Promise<void> {
  const file = path.join(repo, relative)
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, content)
}

export async function commitAll(repo: string, message: string): Promise<void> {
  await git(repo, 'add', '-A')
  await git(repo, 'commit', '-q', '-m', message)
}
