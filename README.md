# PeekAtGit

[![CI](https://github.com/Filo6699/peekatgit/actions/workflows/ci.yml/badge.svg)](https://github.com/Filo6699/peekatgit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >=22.18](https://img.shields.io/badge/node-%3E%3D22.18-informational)
![dependencies: none](https://img.shields.io/badge/runtime%20deps-0-success)

A lightweight source control app in its own window. Review changes across repositories,
stage files, commit, sync and explore Git history.

```
node src/server.ts /path/to/folder     # or: bun src/server.ts
```

Opens as its own window — no tabs, no address bar, its own entry in the window switcher.
Under the hood it is a local server on `127.0.0.1:4141` displayed by a chromium-family browser
in app mode, so there is no runtime to bundle and no 150 MB of Electron. Closing the window
quits the tool. The window keeps its own profile in `~/.config/peekatgit/window`, so it
remembers its size and never touches the browser session you already have open.

With no chromium-family browser installed it falls back to a browser tab and says so.

## Install

`src/server.ts` is the executable — it carries a `#!/usr/bin/env node` shebang, and node runs
TypeScript directly, so a symlink is the whole install:

```
ln -sf "$PWD/src/server.ts" ~/.local/bin/peekatgit     # or: npm run link
```

Then, from anywhere:

```
peekatgit [workspace-or-repo-path] [options]

  --port <n>    listen on this port instead of 4141
  --browser     open a browser tab instead of an app window
  --no-open     just serve; open it yourself
  --foreground  stay attached to this terminal instead of detaching
```

With no path it reopens the last workspace, falling back to the current directory.

The command prints the url and returns your prompt immediately: the server re-execs itself
into its own session, so it keeps running when you close the terminal and never prints
anything into it again. Its output goes to `~/.local/state/peekatgit/peekatgit.log`
(truncated on every launch). Closing the app window still quits it; otherwise
`pkill -f peekatgit`. Use `--foreground` when you want it tied to the shell after all. Because it is a symlink,
`git pull` in this repo updates the installed command — nothing to rebuild unless you touch
`src/client/`.

## Workspaces

The path you point at can be either a repository or a folder full of them. PeekAtGit looks in
the folder itself and **one level down**, so a directory like

```
~/work/            ← point here
  api/             ← repo
  web/             ← repo
  scratch/         ← not a repo, skipped
  wt/web-feature/  ← too deep for the scan; add it from the worktree list
```

gives you `api` and `web` side by side, each with its own change list and commit box. All of
them are on screen at once; nothing is behind a repo picker.

Per-repository preferences are PeekAtGit's own, not git's, and live in
`~/.config/peekatgit/config.json` keyed by workspace:

- **hidden** — `hide` on the repo header parks a repo you do not care about. Hidden repos cost
  nothing: they are skipped by the status reads and the watcher entirely. The topbar offers to
  show them again.
- **sort order** — `↑` / `↓` on the header. Survives restarts.

## Worktrees

A linked worktree (one whose `.git` is a file) is a first-class repository in the list, marked
`WORKTREE`. Repos with more than one checkout show a `⑂N` chip; opening it lists every worktree
with its branch. Worktrees that live outside the scanned depth get a `+` to pin them into the
list permanently — and `drop` to remove them again.

## Source control

- **Changes** — every repository has staged and working-tree changes, per-file and bulk
  stage/unstage actions, discard with confirmation, and a commit message box.
- **History** — commit graphs with branches, tags, authors and adjustable depth.
- **Sync** — fetch, integrate upstream changes and push local commits for tracked branches.
- **Worktrees** — discover linked checkouts and pin them into the workspace.
- **Live updates** — filesystem events and background polling keep repository state current.

The application is focused on Git. There is no file editor, project explorer or embedded
terminal. Select a changed file to review its unified diff with line numbers and syntax
colouring. Use Ctrl/Cmd+Enter in a commit message to commit staged changes.

## Why it stays small

No runtime dependencies, framework, web fonts or Electron. The server uses Node's standard
library and the Git executable; the browser receives one bundled script and a stylesheet.
The generated `public/app.js` is committed so a clone runs without a build step.

## Development

```
bun run build       # bundle src/client → public/app.js 
bun run dev         # same, in watch mode
bun run typecheck   # tsc --noEmit
npm test            # node --test test/*.test.ts
npm run check       # typecheck + tests, what CI runs
```

`public/app.js` is a build artifact but is committed so the tool runs straight from a clone —
CI fails if it does not match `src/client/`.

The tests are `node:test` against real repositories created in a temp directory: nothing about
git is mocked, and `test/server.test.ts` boots the actual CLI and talks to it over HTTP.
See [CONTRIBUTING.md](CONTRIBUTING.md).

## Layout

```
src/server.ts             CLI and HTTP routing
src/server/workspace.ts   repository discovery, preferences and summaries
src/server/git.ts         Git commands and parsing
src/server/watch.ts       filesystem watchers, polling and SSE
src/server/config.ts      workspace preferences
src/server/window.ts      native browser app window
src/client/app.ts         bootstrap and refresh orchestration
src/client/sidebar.ts     repositories, changes, commits and worktrees
src/client/viewer.ts      selected change and unified diff
src/client/graph.ts       commit history
src/client/lanes.ts       graph layout
src/shared/types.ts       shared API types
public/                   app shell, stylesheet and generated bundle
test/                     tests against real temporary Git repositories
```

Repository ids must belong to the discovered workspace, and Git operations reject paths
that escape their repository. Discard changes files on disk; it requires confirmation.
