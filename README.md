# PeekAtGit

[![CI](https://github.com/Filo6699/peekatgit/actions/workflows/ci.yml/badge.svg)](https://github.com/Filo6699/peekatgit/actions/workflows/ci.yml)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
![node >=22.18](https://img.shields.io/badge/node-%3E%3D22.18-informational)
![dependencies: none](https://img.shields.io/badge/runtime%20deps-0-success)

A tiny git viewer in its own window: every repository in a folder on the left, one file at a
time on the right. No editor, no extensions.

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

With no path it uses the current directory. Cold start is ~120 ms.

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

## The look

The instrument this borrows from is the diff gutter: a narrow column of marks down the left of
every line. Here *every* row has one — repositories, files, tree entries, code, diff lines — so
the whole window reads as a single ledger you scan down the left edge. `M` modified, `+` new,
`−` deleted, `→` renamed, `!` conflict; a filled dot on a repo means it has work in it.

Everything that is data — repo names, paths, branches, code — is monospace, because it is all
read the same way: by scanning for the character that differs. The only sans in the app is the
tiny uppercase section label, and it is meant to recede. No web fonts: a tool that starts in
120 ms should not wait on a font.

**Every repository is a block** with a gap of floor beneath it and a spine down its left edge in
a colour it keeps: the spine, its name, its name in the project tree, its name in the viewer
header. Eight colours, muted, assigned by name — you learn them in a day and never have to read
a header again to know where you are.

Three more rules keep the sidebar readable at this density:

- a clean repository is **one line**, and all the clean ones are parked together at the bottom
  under a `N clean` label — the repos with work in them stay at the top;
- files sharing a directory are gathered under **one dim heading**; a lone file keeps its
  directory inline instead, because a heading for one row costs two lines to say what one can;
- filenames never yield space to paths — the path ellipsizes first.

The divider between the panes is a drag handle; the width is remembered.

## Two tabs

**Changes** is the repository view above. **Files** is one tree over the whole project — the
directories *between* the repositories belong to it too, so browsing is not scoped to a
checkout. Repositories appear in it in their own colour; gitignored entries are dimmed. Opening
a file that happens to live inside a repository offers its diff.

## What it does

- **Source control** — staged / changed lists per repo, per-file stage, unstage, discard,
  stage-all, and a commit box that appears once something is staged (⌘/Ctrl+Enter commits).
- **Diff view** — unified diff with line gutters and syntax colouring, working tree or index.
- **Files tab** — one lazy tree over the whole workspace, gitignored entries dimmed.
- **Live** — see below. Scroll position, tree expansion and half-typed commit messages all
  survive a refresh.

## How "live" stays cheap

Watching every repository in a workspace recursively would mean an inotify handle per directory
across the whole tree, which is exactly the load worth avoiding. Instead:

- the **three most recently opened** repos get a recursive watcher, so edits appear instantly;
- everything else is swept by a **status poll**, eight repos per 2.5 s tick, comparing one
  `git status -b` string per repo;
- the workspace root is watched shallowly, so a repo appearing or vanishing triggers a rescan;
- repository summaries are cached and invalidated per repo, so an edit in one repo does not
  re-read the other fifty.

The server pushes the ids of the repos that changed over SSE; the client re-reads only those.

## Why it's small

- **Zero runtime dependencies.** Node 22.18+ and Bun execute TypeScript directly, so
  `src/server.ts` is the binary. All git work is `execFile('git', …)` — no git reimplementation.
- **The client is one ~17 KB bundle.** No framework, no virtual DOM, no CSS toolchain.
- `typescript` is a devDependency, used only for `npm run typecheck`.

## Development

```
bun run build       # bundle src/client → public/app.js  (~10ms)
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
src/server/workspace.ts   repo discovery, prefs, summaries
src/server/git.ts         every call that shells out to git
src/server/watch.ts       watchers, poll loop, SSE fan-out
src/server/config.ts      ~/.config/peekatgit/config.json
src/server/window.ts      finding a browser and opening the app window
src/client/app.ts         bootstrap, refresh orchestration, SSE
src/client/sidebar.ts     tabs, repo blocks, change lists, project tree, worktrees
src/client/viewer.ts      the single file / diff pane
src/client/diff.ts        unified-diff parser
src/client/highlight.ts   ~120-line syntax highlighter
src/shared/types.ts       wire types shared by both sides
public/                   index.html, style.css, built app.js
test/                     node:test suites over real temporary repos
```

## Notes

- Read-only for file contents — PeekAtGit never writes to your files. The only mutations are
  git plumbing: `add`, `reset`, `checkout --`, `commit`.
- Repository ids are absolute paths, and the server only accepts ids it discovered itself.
  Paths are rejected if they escape the repository — or, in the Files tab, the workspace.
- Files over 2 MB and binaries are not rendered.
