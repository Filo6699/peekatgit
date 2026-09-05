// Detaching from the terminal that started us.
//
// `peekatgit` is a thing you leave running while you work, so it has no business
// holding on to the shell you launched it from. The first process re-execs
// itself in a new session, waits just long enough to learn the url, prints it,
// and gets out of the way. The real server writes nothing to that terminal ever
// again — its output goes to a log file instead.

import { spawn } from 'node:child_process'
import { mkdirSync, openSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const STATE_DIR = path.join(process.env.XDG_STATE_HOME || path.join(homedir(), '.local', 'state'), 'peekatgit')

export const logPath = path.join(STATE_DIR, 'peekatgit.log')

/** Set on the detached child so it knows not to fork again. */
const MARKER = 'PEEKATGIT_DETACHED'

export const isDetachedChild = process.env[MARKER] === '1'

type Ready = { url: string; where: string }

/**
 * Re-execs this process detached from the terminal. The returned promise never
 * settles: the launcher's only remaining job is to print the url and exit, which
 * happens here. Awaiting it is what keeps the launcher from also starting a
 * server of its own.
 */
export function detach(): Promise<never> {
  mkdirSync(STATE_DIR, { recursive: true })
  // Truncated per launch: the interesting log is always the current run's.
  const log = openSync(logPath, 'w')

  const child = spawn(process.execPath, [...process.execArgv, process.argv[1]!, ...process.argv.slice(2)], {
    detached: true,
    stdio: ['ignore', log, log, 'ipc'],
    env: { ...process.env, [MARKER]: '1' },
  })

  child.on('message', (message: Ready) => {
    console.log(`PeekAtGit → ${message.url}  (${message.where})`)
    console.log(`  running in the background — logs: ${logPath}`)
    child.disconnect()
    child.unref()
    process.exit(0)
  })

  // Startup failed before the server came up; the reason is in the log.
  child.on('exit', code => {
    const reason = readFileSync(logPath, 'utf8').trim()
    if (reason) console.error(reason)
    process.exit(code ?? 1)
  })

  child.on('error', error => {
    console.error(`peekatgit: could not detach: ${(error as Error).message}`)
    process.exit(1)
  })

  return new Promise<never>(() => {})
}

/** Tells the launcher we are serving, then lets it go. */
export function reportReady(info: Ready): void {
  // These only exist on a process started with an ipc channel — which is us,
  // when the launcher spawned us, and nobody at all when run by hand. The
  // launcher hangs up as soon as it reads the message, so the channel may
  // already be closed by the time we get here: disconnecting a closed channel
  // emits an 'error' on the process, and nothing listens for that, which used
  // to take the whole server down at the moment it came up.
  if (!process.send || !process.connected) return
  process.send(info, undefined, undefined, () => {})
  if (process.connected) process.disconnect()
}
