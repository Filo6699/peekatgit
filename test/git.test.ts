// The git layer: porcelain parsing, path containment, and the handful of reads
// the sidebar depends on.

import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import {
  diff,
  fileContent,
  hasHead,
  head,
  ignoredNames,
  listDir,
  parseStatus,
  resolveSafe,
  status,
  toplevel,
  worktrees,
} from '../src/server/git.ts'
import { cleanup, commitAll, git, makeRepo, tempDir, write } from './helpers.ts'

after(cleanup)

describe('parseStatus', () => {
  test('splits the index column from the worktree column', () => {
    const report = parseStatus(['M  staged.txt', ' M dirty.txt', 'MM both.txt'].join('\0') + '\0')

    assert.deepEqual(
      report.staged.map(entry => [entry.path, entry.status]),
      [
        ['both.txt', 'M'],
        ['staged.txt', 'M'],
      ]
    )
    assert.deepEqual(
      report.changes.map(entry => [entry.path, entry.status]),
      [
        ['both.txt', 'M'],
        ['dirty.txt', 'M'],
      ]
    )
  })

  test('untracked files count once, as a change', () => {
    const report = parseStatus('?? fresh.txt\0')
    assert.deepEqual(report.staged, [])
    assert.deepEqual(report.changes, [{ path: 'fresh.txt', status: '?', untracked: true }])
  })

  test('a rename carries the path it came from', () => {
    const report = parseStatus('R  after.txt\0before.txt\0 M other.txt\0')
    assert.deepEqual(report.staged, [{ path: 'after.txt', status: 'R', from: 'before.txt' }])
    // The extra record must be consumed, or every later entry shifts by one.
    assert.deepEqual(report.changes, [{ path: 'other.txt', status: 'M', from: null }])
  })

  test('empty status is empty', () => {
    assert.deepEqual(parseStatus(''), { staged: [], changes: [] })
  })
})

describe('resolveSafe', () => {
  test('keeps repo-relative paths', () => {
    assert.equal(resolveSafe('/repo', 'src/a.ts'), path.join('/repo', 'src/a.ts'))
    assert.equal(resolveSafe('/repo', ''), '/repo')
  })

  test('refuses to leave the repository', () => {
    for (const escape of ['../secret', 'src/../../secret', '/etc/passwd']) {
      assert.throws(() => resolveSafe('/repo', escape), /escapes repository/)
    }
  })

  test('a sibling directory sharing the prefix is still outside', () => {
    assert.throws(() => resolveSafe('/repo', '../repo-other/file'), /escapes repository/)
  })
})

describe('against a real repository', () => {
  test('head, status and hasHead track the repo', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))

    assert.equal(await hasHead(repo), false, 'no commit yet')

    await write(repo, 'README.md', '# alpha\n')
    await commitAll(repo, 'first')

    assert.equal(await hasHead(repo), true)
    assert.equal((await head(repo)).branch, 'main')
    assert.equal((await head(repo)).tracking, '', 'no upstream configured')
    assert.equal(await toplevel(repo), repo)

    await write(repo, 'README.md', '# alpha\nmore\n')
    await write(repo, 'new.txt', 'hello\n')
    await git(repo, 'add', 'new.txt')

    const report = await status(repo)
    assert.deepEqual(report.staged.map(e => e.path), ['new.txt'])
    assert.deepEqual(report.changes.map(e => e.path), ['README.md'])
  })

  test('toplevel returns null outside a checkout', async () => {
    assert.equal(await toplevel(await tempDir()), null)
  })

  test('diff reports tracked edits and untracked files alike', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'first')
    await write(repo, 'a.txt', 'two\n')
    await write(repo, 'b.txt', 'brand new\n')

    assert.match(await diff(repo, 'a.txt', false, false), /^\+two$/m)
    assert.match(await diff(repo, 'b.txt', false, true), /^\+brand new$/m)
    await assert.rejects(() => diff(repo, '../outside.txt', false, false), /escapes repository/)
  })

  test('listDir sorts directories first and marks ignored entries', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))
    await write(repo, '.gitignore', 'ignored.txt\n')
    await write(repo, 'visible.txt', 'x\n')
    await write(repo, 'ignored.txt', 'x\n')
    await write(repo, 'src/deep.ts', 'x\n')
    await commitAll(repo, 'first')

    const entries = await listDir(repo, '')
    assert.deepEqual(entries.map(e => e.name), ['src', '.gitignore', 'ignored.txt', 'visible.txt'])
    assert.equal(entries.find(e => e.name === 'src')?.dir, true)
    assert.equal(entries.find(e => e.name === 'ignored.txt')?.ignored, true)
    assert.equal(entries.find(e => e.name === 'visible.txt')?.ignored, false)
    assert.equal(entries.some(e => e.name === '.git'), false, '.git is never listed')

    const nested = await listDir(repo, 'src')
    assert.deepEqual(nested.map(e => e.path), ['src/deep.ts'])
  })

  test('ignoredNames answers for a whole directory at once', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))
    await write(repo, '.gitignore', '*.log\n')
    await commitAll(repo, 'first')

    const ignored = await ignoredNames(repo, '', ['app.log', 'app.ts'])
    assert.deepEqual([...ignored], ['app.log'])
    assert.equal((await ignoredNames(repo, '', [])).size, 0)
  })

  test('fileContent flags binary and oversized files instead of shipping them', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))
    await write(repo, 'text.txt', 'plain\n')
    await write(repo, 'blob.bin', 'head\0tail')

    assert.equal((await fileContent(repo, 'text.txt')).content, 'plain\n')
    assert.equal((await fileContent(repo, 'blob.bin')).binary, true)
    await assert.rejects(() => fileContent(repo, '../escape.txt'), /escapes repository/)
  })

  test('worktrees lists the checkout it was asked about as current', async () => {
    const root = await tempDir()
    const repo = await makeRepo(path.join(root, 'alpha'))
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'first')
    await git(repo, 'worktree', 'add', '-q', '-b', 'feature', path.join(root, 'alpha-feature'))

    const trees = await worktrees(repo)
    assert.equal(trees.length, 2)
    const current = trees.find(tree => tree.current)
    assert.equal(current?.path, repo)
    assert.equal(current?.branch, 'main')
    assert.equal(trees.find(tree => !tree.current)?.branch, 'feature')
  })
})
