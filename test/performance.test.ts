import assert from 'node:assert/strict'
import { test } from 'node:test'
import { limitConcurrency } from '../src/server/queue.ts'
import { refreshQueue } from '../src/client/refresh.ts'
import { countChanges, parseDiff } from '../src/client/diff.ts'

function gate() {
  let release!: () => void
  const promise = new Promise<void>(resolve => { release = resolve })
  return { promise, release }
}

test('subprocess queue bounds concurrent work and recovers after rejection', async () => {
  const run = limitConcurrency(4)
  const first = gate()
  let active = 0
  let peak = 0
  const results = Array.from({ length: 25 }, (_, index) => run(async () => {
    active++
    peak = Math.max(peak, active)
    await first.promise
    active--
    if (index === 0) throw new Error('failed Git command')
    return index
  }))
  assert.equal(active, 4)
  first.release()
  const settled = await Promise.allSettled(results)
  assert.equal(peak, 4)
  assert.equal(active, 0)
  assert.equal(settled.filter(result => result.status === 'fulfilled').length, 24)
})

test('refresh merges a burst and queues events arriving during an active read', async () => {
  const first = gate()
  const entered = gate()
  const calls: Array<string[] | undefined> = []
  const refresh = refreshQueue(async repos => {
    calls.push(repos)
    if (calls.length === 1) { entered.release(); await first.promise }
  })
  const pending = refresh(['alpha'])
  void refresh(['beta', 'alpha'])
  await entered.promise
  void refresh(['gamma'])
  void refresh(['gamma', 'delta'])
  assert.deepEqual(calls, [['alpha', 'beta']])
  first.release()
  await pending
  assert.deepEqual(calls, [['alpha', 'beta'], ['gamma', 'delta']])
  await refresh()
  assert.equal(calls[2], undefined)
})

test('a full refresh wins over partial refreshes, and failures do not wedge the queue', async () => {
  let fail = true
  const calls: Array<string[] | undefined> = []
  const refresh = refreshQueue(async repos => {
    calls.push(repos)
    if (fail) { fail = false; throw new Error('offline') }
  })
  const pending = refresh(['alpha'])
  void refresh()
  await assert.rejects(pending, /offline/)
  await refresh(['beta'])
  assert.deepEqual(calls, [undefined, ['beta']])
})

test('diff preserves header-like content, blank context, binary and mode changes', () => {
  const rows = parseDiff('diff --git a/a b/a\n--- a/a\n+++ b/a\n@@ -1,2 +1,2 @@\n--- removed\n+++ added\n \n')
  assert.deepEqual(countChanges(rows), { added: 1, removed: 1 })
  assert.equal(rows[1]?.text, '-- removed')
  assert.equal(rows[2]?.text, '++ added')
  assert.equal(rows[3]?.text, '')
  const binary = parseDiff('diff --git a/a b/a\nold mode 100644\nnew mode 100755\nBinary files a/a and b/a differ\n')
  assert.equal(binary.length, 3)
  assert.ok(binary.every(row => row.kind === 'meta'))
})
