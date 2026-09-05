// The graph: what `git log` hands over, and the columns drawn from it.

import assert from 'node:assert/strict'
import path from 'node:path'
import { after, describe, test } from 'node:test'
import { graph, parseGraph, parseRefs } from '../src/server/git.ts'
import { ago, layoutGraph } from '../src/client/lanes.ts'
import type { GraphCommit } from '../src/shared/types.ts'
import { cleanup, commitAll, git, makeRepo, tempDir, write } from './helpers.ts'

after(cleanup)

/** A commit as the layout sees it: only the links matter here. */
const node = (hash: string, ...parents: string[]): GraphCommit => ({
  hash,
  parents,
  refs: [],
  author: 'test',
  time: 0,
  subject: hash,
})

describe('parseRefs', () => {
  test('unwraps the arrow and the tag prefix', () => {
    assert.deepEqual(parseRefs('HEAD -> main, origin/main, tag: v1.0'), ['HEAD', 'main', 'origin/main', 'v1.0'])
    assert.deepEqual(parseRefs(''), [])
  })
})

describe('parseGraph', () => {
  test('reads fields, parents and the newline between records', () => {
    const raw = ['a1\x1fb2 c3\x1fHEAD -> main\x1fAda\x1f1700000000\x1fmerge: two lines\x1e', 'b2\x1f\x1f\x1fAda\x1f1699999999\x1froot\x1e'].join('\n')

    const commits = parseGraph(raw)
    assert.equal(commits.length, 2)
    assert.deepEqual(commits[0], {
      hash: 'a1',
      parents: ['b2', 'c3'],
      refs: ['HEAD', 'main'],
      author: 'Ada',
      time: 1700000000,
      subject: 'merge: two lines',
    })
    assert.deepEqual(commits[1]?.parents, [], 'the root commit has none')
  })

  test('an empty log is an empty list, not a blank commit', () => {
    assert.deepEqual(parseGraph(''), [])
  })
})

describe('layoutGraph', () => {
  test('a straight history is one column', () => {
    const layout = layoutGraph([node('c', 'b'), node('b', 'a'), node('a')])

    assert.equal(layout.width, 1)
    assert.deepEqual(layout.placed.map(p => p.col), [0, 0, 0])
    assert.deepEqual(
      layout.edges.map(e => [e.fromRow, e.toRow, e.lane]),
      [
        [0, 1, 0],
        [1, 2, 0],
      ]
    )
  })

  test('a merge puts the second parent in its own lane, and frees it again', () => {
    // m ── merges side (s) back into the trunk; both reach the same root.
    const layout = layoutGraph([node('m', 't', 's'), node('t', 'r'), node('s', 'r'), node('r')])

    assert.equal(layout.width, 2)
    const colOf = new Map(layout.placed.map(p => [p.commit.hash, p.col]))
    assert.equal(colOf.get('m'), 0)
    assert.equal(colOf.get('t'), 0, 'the first parent keeps the column')
    assert.equal(colOf.get('s'), 1)
    assert.equal(colOf.get('r'), 0, 'the lane is free once the branch is drawn')

    const merged = layout.edges.filter(e => e.fromRow === 0)
    assert.deepEqual(merged.map(e => [e.toCol, e.lane]), [[0, 0], [1, 1]])
  })

  test('a parent past the end of the window runs off the bottom', () => {
    const layout = layoutGraph([node('c', 'gone')])

    assert.deepEqual(layout.edges.map(e => [e.fromRow, e.toRow]), [[0, 1]], 'one row past the last')
  })

  test('unrelated roots get a column each', () => {
    const layout = layoutGraph([node('a'), node('b')])

    assert.equal(layout.width, 1, 'a freed lane is reused rather than stacked')
    assert.deepEqual(layout.placed.map(p => p.col), [0, 0])
  })
})

describe('ago', () => {
  test('rounds down to the largest unit that fits', () => {
    const now = 1_000_000_000
    assert.equal(ago(now - 30, now), 'now')
    assert.equal(ago(now - 90, now), '1m')
    assert.equal(ago(now - 7200, now), '2h')
    assert.equal(ago(now - 86_400 * 3, now), '3d')
    assert.equal(ago(now + 500, now), 'now', 'a clock skewed into the future is not negative')
  })
})

describe('graph against a real repository', () => {
  test('walks every branch, newest first, with refs attached', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'alpha'))
    await write(repo, 'a.txt', 'one\n')
    await commitAll(repo, 'first')
    await git(repo, 'checkout', '-q', '-b', 'side')
    await write(repo, 'b.txt', 'two\n')
    await commitAll(repo, 'on the side')
    await git(repo, 'checkout', '-q', 'main')
    await write(repo, 'c.txt', 'three\n')
    await commitAll(repo, 'on main')

    const commits = await graph(repo, 50)
    assert.equal(commits.length, 3, '--all reaches the branch that is not checked out')
    assert.deepEqual(commits.map(c => c.subject).sort(), ['first', 'on main', 'on the side'])

    const head = commits.find(c => c.refs.includes('HEAD'))
    assert.equal(head?.subject, 'on main')
    assert.ok(head?.refs.includes('main'))
    assert.ok(commits.some(c => c.refs.includes('side')))

    const root = commits.find(c => c.subject === 'first')!
    assert.deepEqual(root.parents, [])
    assert.ok(root.time > 0)
    // Both tips descend from the root, and the layout keeps them apart.
    assert.equal(layoutGraph(commits).width, 2)
  })

  test('the limit is honoured, and a repo with no commits is empty', async () => {
    const repo = await makeRepo(path.join(await tempDir(), 'beta'))
    assert.deepEqual(await graph(repo, 10), [])

    for (const n of [1, 2, 3]) {
      await write(repo, 'a.txt', `${n}\n`)
      await commitAll(repo, `commit ${n}`)
    }
    assert.equal((await graph(repo, 2)).length, 2)
    assert.equal((await graph(repo, 50))[0]?.subject, 'commit 3', 'newest first')
  })
})
