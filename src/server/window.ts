// Opening PeekAtGit as its own window.
//
// Chromium-family browsers have an app mode: no tabs, no address bar, its own
// entry in the window switcher — a separate window in every way that matters.
// It costs nothing to ship, unlike bundling a runtime with the tool. The
// profile directory is ours, so the window remembers its size and position and
// never touches the browser session you already have open.

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { homedir } from 'node:os'
import path from 'node:path'

const CANDIDATES = [
  'chromium',
  'chromium-browser',
  'google-chrome-stable',
  'google-chrome',
  'brave-browser',
  'vivaldi-stable',
  'microsoft-edge',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
  '/Applications/Chromium.app/Contents/MacOS/Chromium',
  '/Applications/Brave Browser.app/Contents/MacOS/Brave Browser',
]

const PATH_DIRS = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean)

function findBrowser(): string | null {
  for (const candidate of CANDIDATES) {
    if (candidate.includes('/')) {
      if (existsSync(candidate)) return candidate
      continue
    }
    for (const dir of PATH_DIRS) {
      if (existsSync(path.join(dir, candidate))) return path.join(dir, candidate)
    }
  }
  return null
}

const profileDir = path.join(
  process.env.XDG_CONFIG_HOME || path.join(homedir(), '.config'),
  'peekatgit',
  'window'
)

/**
 * Launches the app window. Resolves to false when no chromium-family browser is
 * installed, so the caller can fall back to a plain browser tab.
 * `onClose` fires when the user closes the window — that is the app quitting.
 */
export function openWindow(url: string, onClose: () => void): boolean {
  const browser = findBrowser()
  if (!browser) return false

  const child = spawn(
    browser,
    [
      `--app=${url}`,
      `--user-data-dir=${profileDir}`,
      '--no-first-run',
      '--no-default-browser-check',
      '--disable-features=Translate,MediaRouter',
      '--window-size=1280,860',
    ],
    { stdio: 'ignore', detached: false }
  )

  child.on('error', onClose)
  child.on('exit', onClose)
  return true
}

/** Hands the url to whatever the desktop opens links with. */
export function openInBrowser(url: string): void {
  const opener = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'
  spawn(opener, [url], { stdio: 'ignore', detached: true }).on('error', () => {}).unref()
}
