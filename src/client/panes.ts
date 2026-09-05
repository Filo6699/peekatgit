import { byId } from './dom.ts'

export type Pane = 'viewer' | 'graph'
const panes: Record<Pane, HTMLElement> = {
  viewer: document.querySelector('.viewer') as HTMLElement,
  graph: byId('graph'),
}
export function showPane(which: Pane): void {
  for (const [name, node] of Object.entries(panes)) node.hidden = name !== which
}
