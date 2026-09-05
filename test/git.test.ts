// The git layer: porcelain parsing, path containment, and the handful of reads
// the sidebar depends on.

import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import {
  diff,
  hasHead,
  headAndStatus,
  parseBranchHeader,
  parseStatus,
  resolveSafe,
  status,
  toplevel,
  worktreeCount,
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

describe('parseBranchHeader', () => {
  test('branch, upstream and the counts beside it', () => {
    assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 1, behind 2]'), {
      branch: 'main',
      tracking: 'origin/main',
      ahead: 1,
      behind: 2,
    })
    assert.deepEqual(parseBranchHeader('## main...origin/main [ahead 3]'), {
      branch: 'main',
      tracking: 'origin/main',
      ahead: 3,
      behind: 0,
    })
  })

  test('no upstream, a gone one, and a detached head', () => {
    assert.deepEqual(parseBranchHeader('## main'), { branch: 'main', tracking: '', ahead: 0, behind: 0 })
    assert.deepEqual(parseBranchHeader('## work...origin/work [gone]'), {
      branch: 'work',
      tracking: 'origin/work',
      ahead: 0,
      behind: 0,
    })
    assert.deepEqual(parseBranchHeader('## HEAD (no branch)'), {
      branch: 'HEAD',
      tracking: '',
      ahead: 0,
      behind: 0,
    })
  })

  test('an empty repository still names its branch', () => {
    assert.deepEqual(parseBranchHeader('## No commits yet on main'), {
      branch: 'main',
      tracking: '',
      ahead: 0,
      behind: 0,
    })
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
    const summary = await headAndStatus(repo)
    assert.equal(summary.head.branch, 'main')
    assert.equal(summary.head.tracking, '', 'no upstream configured')
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
    await assert.rejects(() => diff(repo, 'missing.txt', false, true))
    await assert.rejects(() => diff(repo, '../outside.txt', false, false), /escapes repository/)
  })


})
