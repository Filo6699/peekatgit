// Turning parent links into columns. No DOM in here — this is the part of the
// graph that is arithmetic, and the part worth having tests for.
//
//   1. a commit keeps its column for as long as its first parent does, so the
//      trunk of a branch stays a straight line down the page;
//   2. a lane is freed the moment nothing points into it any more, so a repo
//      with a hundred merged branches still fits in a handful of columns.

import type { GraphCommit } from '../shared/types.ts'

export type Placed = { commit: GraphCommit; row: number; col: number }
export type Edge = { fromRow: number; fromCol: number; toRow: number; toCol: number; lane: number }
export type Layout = { placed: Placed[]; edges: Edge[]; width: number }

const firstFree = (lanes: (string | null)[]): number => {
  const free = lanes.indexOf(null)
  return free === -1 ? lanes.length : free
}

/**
 * Walks the commits newest-first, handing each one a column. `lanes[i]` is the
 * commit that column i is currently waiting for — which is why a parent claims
 * its column the moment a child mentions it, and holds it until it is drawn.
 */
export function layoutGraph(commits: GraphCommit[]): Layout {
  const lanes: (string | null)[] = []
  const rowOf = new Map<string, number>()
  const colOf = new Map<string, number>()
  const placed: Placed[] = []
  const pending: Array<{ fromRow: number; fromCol: number; parent: string; lane: number }> = []
  let width = 1

  commits.forEach((commit, row) => {
    let col = lanes.indexOf(commit.hash)
    if (col === -1) {
      col = firstFree(lanes)
      lanes[col] = commit.hash
    }
    rowOf.set(commit.hash, row)
    colOf.set(commit.hash, col)
    placed.push({ commit, row, col })
    lanes[col] = null // free it; the first parent usually takes it straight back

    commit.parents.forEach((parent, index) => {
      let lane = lanes.indexOf(parent)
      if (lane === -1) {
        // The first parent continues this line of development, so it inherits
        // the column — a second parent is a merged branch and gets its own.
        lane = index === 0 && lanes[col] === null ? col : firstFree(lanes)
        lanes[lane] = parent
      }
      pending.push({ fromRow: row, fromCol: col, parent, lane })
    })

    // Trailing empty lanes do not count towards the width.
    while (lanes.length && lanes[lanes.length - 1] === null) lanes.pop()
    width = Math.max(width, lanes.length, col + 1)
  })

  const edges: Edge[] = pending.map(link => ({
    fromRow: link.fromRow,
    fromCol: link.fromCol,
    // A parent outside the window has no row of its own; its line runs off the bottom.
    toRow: rowOf.get(link.parent) ?? commits.length,
    toCol: colOf.get(link.parent) ?? link.lane,
    lane: link.lane,
  }))
  return { placed, edges, width }
}

const RELATIVE: Array<[seconds: number, unit: string]> = [
  [31_536_000, 'y'],
  [2_592_000, 'mo'],
  [604_800, 'w'],
  [86_400, 'd'],
  [3600, 'h'],
  [60, 'm'],
]

/** Ages, not dates: on a graph the only question is how long ago. */
export function ago(seconds: number, now = Date.now() / 1000): string {
  const delta = Math.max(0, now - seconds)
  for (const [size, unit] of RELATIVE) if (delta >= size) return `${Math.floor(delta / size)}${unit}`
  return 'now'
}
