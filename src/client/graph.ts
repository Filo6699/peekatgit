// The graph tab: every connected repository drawn side by side, each one a
// vertical commit graph with the newest commit at the top.
//
// The server only hands over commits and their parent links; the columns are
// worked out in lanes.ts, and everything here is the drawing of them. Colour
// follows the lane, which is the only thing on the page that is continuous.

import type { RepoGraph } from '../shared/types.ts'
import { api } from './api.ts'
import { byId, el } from './dom.ts'
import { ago, layoutGraph, type Edge, type Layout, type Placed } from './lanes.ts'
import { showPane } from './panes.ts'
import { hooks, repoColor, state, visibleRepos } from './state.ts'
import { mark } from './trace.ts'

const ROW = 22
const LANE = 13
const PAD = 11
const DOT = 3.6

/** Lane colours. Distinct at a glance, and none of them the status colours. */
const LANE_COLORS = ['#86c8de', '#a3cb6d', '#f0bd5c', '#ef8a6a', '#ab8fc7', '#6fb0a6', '#d09a63', '#c98db4']

const DEPTHS = [30, 60, 150, 400]
const DEPTH_KEY = 'peekatgit.graph.depth'

const host = byId('graphBody')
const metaEl = byId('graphMeta')
const depthEl = byId<HTMLSelectElement>('graphDepth')

const graphs = new Map<string, RepoGraph>()
let depth = Number(localStorage.getItem(DEPTH_KEY)) || 60
let loading = false

export const graphCount = (repoId: string): number => graphs.get(repoId)?.commits.length ?? 0

// ---------------------------------------------------------------- drawing
const laneColor = (lane: number): string => LANE_COLORS[lane % LANE_COLORS.length]!

const x = (col: number): number => PAD + col * LANE
const y = (row: number): number => row * ROW + ROW / 2

/** Straight down the lane, with one elbow just under the commit it leaves. */
function edgePath(edge: Edge): string {
  const [x1, y1, x2, y2] = [x(edge.fromCol), y(edge.fromRow), x(edge.toCol), y(edge.toRow)]
  if (x1 === x2) return `M${x1} ${y1}V${y2}`
  const bend = Math.min(ROW, y2 - y1)
  const mid = y1 + bend
  return `M${x1} ${y1}C${x1} ${y1 + bend * 0.55} ${x2} ${mid - bend * 0.55} ${x2} ${mid}V${y2}`
}

const svgEl = <K extends keyof SVGElementTagNameMap>(tag: K): SVGElementTagNameMap[K] =>
  document.createElementNS('http://www.w3.org/2000/svg', tag)

function drawLines(layout: Layout, rows: number, width: number): SVGSVGElement {
  const svg = svgEl('svg')
  svg.setAttribute('class', 'glines')
  svg.setAttribute('width', String(width))
  svg.setAttribute('height', String(rows * ROW))

  for (const edge of layout.edges) {
    const path = svgEl('path')
    path.setAttribute('d', edgePath(edge))
    path.setAttribute('stroke', laneColor(edge.lane))
    svg.append(path)
  }
  for (const { row, col, commit } of layout.placed) {
    const dot = svgEl('circle')
    dot.setAttribute('cx', String(x(col)))
    dot.setAttribute('cy', String(y(row)))
    dot.setAttribute('r', String(commit.parents.length > 1 ? DOT + 1 : DOT))
    dot.setAttribute('fill', laneColor(col))
    // A merge is the one commit whose dot is worth a second look.
    if (commit.parents.length > 1) dot.setAttribute('class', 'merge')
    svg.append(dot)
  }
  return svg
}

function commitRow(placed: Placed, indent: number): HTMLElement {
  const { commit } = placed
  const row = el('div', 'grow')
  row.style.paddingLeft = `${indent}px`
  row.title = [
    commit.hash,
    commit.subject,
    `${commit.author} — ${new Date(commit.time * 1000).toLocaleString()}`,
  ].join('\n')

  for (const ref of commit.refs) {
    const chip = el('span', `gref${ref === 'HEAD' ? ' head' : ''}`, ref)
    row.append(chip)
  }
  row.append(el('span', 'gsubject', commit.subject || '(no message)'))
  row.append(el('span', 'spacer'))
  row.append(el('span', 'gwho', commit.author), el('span', 'gage', ago(commit.time)))
  return row
}

function column(report: RepoGraph): HTMLElement {
  const summary = state.workspace.repos.find(repo => repo.id === report.repo)
  const col = el('section', 'gcol')
  col.dataset.repo = report.repo
  col.style.setProperty('--id', repoColor(report.repo))

  const head = el('div', 'ghead')
  head.append(el('span', 'gdot'), el('span', 'gname', summary?.name ?? report.repo))
  if (summary?.branch) head.append(el('span', 'gbranch', summary.branch))
  head.append(el('span', 'spacer'), el('span', 'gcount', String(report.commits.length)))
  head.title = report.repo
  col.append(head)

  if (report.error) {
    col.append(el('div', 'err', report.error))
    return col
  }
  if (!report.commits.length) {
    col.append(el('div', 'empty', 'No commits yet.'))
    return col
  }

  const layout = layoutGraph(report.commits)
  const indent = x(layout.width - 1) + PAD
  const body = el('div', 'gbody')
  body.append(drawLines(layout, report.commits.length, indent))

  const rows = el('div', 'grows')
  rows.append(...layout.placed.map(placed => commitRow(placed, indent)))
  body.append(rows)
  col.append(body)
  return col
}

// ------------------------------------------------------------------ paint
function render(): void {
  const wanted = visibleRepos().filter(repo => !repo.hidden)
  const columns = wanted.map(repo => graphs.get(repo.id)).filter((report): report is RepoGraph => Boolean(report))

  if (!columns.length) {
    host.replaceChildren(el('div', 'blank', loading ? 'Reading the log…' : 'No repositories to draw.'))
    metaEl.textContent = ''
    return
  }
  const total = columns.reduce((sum, report) => sum + report.commits.length, 0)
  metaEl.textContent = `${columns.length} repo${columns.length === 1 ? '' : 's'} · ${total} commits`
  host.replaceChildren(...columns.map(column))
}

/**
 * Reads the log for the given repos (all visible ones by default) and repaints.
 * Nothing happens while another tab is up — the graph is the most expensive
 * thing here, and it is only worth its `git log` when it is on screen.
 */
export async function refreshGraph(repoIds?: string[]): Promise<void> {
  if (state.tab !== 'graph') return
  const visible = visibleRepos().filter(repo => !repo.hidden).map(repo => repo.id)
  const wanted = repoIds ? visible.filter(id => repoIds.includes(id)) : visible
  // Drop columns for repos that went away or were hidden.
  for (const id of graphs.keys()) if (!visible.includes(id)) graphs.delete(id)
  const missing = visible.filter(id => !graphs.has(id))
  const ask = [...new Set([...wanted, ...missing])]
  if (!ask.length) return render()

  const done = mark('graph')
  loading = true
  render()
  try {
    for (const report of await api.graph(ask, depth)) graphs.set(report.repo, report)
  } finally {
    loading = false
  }
  render()
  hooks.paint() // the sidebar counts what was just read
  done(`${ask.length} repos × ${depth}`)
}

/** Called when the Graph tab is picked: take the pane, then fill it. */
export function openGraph(): void {
  showPane('graph')
  void refreshGraph()
}

export function initGraph(): void {
  depthEl.replaceChildren(
    ...DEPTHS.map(count => {
      const option = el('option', '', `${count} commits`)
      option.value = String(count)
      return option
    })
  )
  if (!DEPTHS.includes(depth)) depth = 60
  depthEl.value = String(depth)
  depthEl.addEventListener('change', () => {
    depth = Number(depthEl.value)
    localStorage.setItem(DEPTH_KEY, String(depth))
    graphs.clear()
    void refreshGraph()
  })
  byId('graphReload').addEventListener('click', () => {
    graphs.clear()
    void refreshGraph()
  })
}

/** The sidebar's repo list jumps here. */
export function scrollToRepo(repoId: string): void {
  host.querySelector(`[data-repo="${CSS.escape(repoId)}"]`)?.scrollIntoView({ block: 'nearest', inline: 'center' })
}
