// The client's half of the stopwatch.
//
// Request timings in the server log stop at the last byte written; everything a
// click actually waits on after that — the browser's connection queue, parsing,
// highlighting, layout — is invisible there. These marks land in the same log,
// so one file has both halves of the story. Silent unless the server was
// started with PEEKATGIT_TRACE=1.

import { state } from './state.ts'

const noop = (): void => {}

/**
 * Starts a stopwatch. Call the returned function when the work is done: it
 * records the time to that point and, one frame later, the time to the paint
 * the user was waiting for.
 */
export function mark(label: string): (detail?: string) => void {
  if (!state.workspace.trace) return noop
  const started = performance.now()
  return (detail = '') => {
    const js = performance.now() - started
    requestAnimationFrame(() => {
      const painted = performance.now() - started
      navigator.sendBeacon(
        '/api/trace',
        `${js.toFixed(1).padStart(8)}ms js ${painted.toFixed(1).padStart(8)}ms painted  ${label} ${detail}`
      )
    })
  }
}
