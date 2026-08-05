# Contributing

## The shape of the thing

PeekAtGit is a viewer. It reads repositories and stages, discards and commits — it does not
edit files, and it does not grow an editor. It has **no runtime dependencies**: the server is
node's standard library plus `git`, the client is hand-written DOM code. Keep it that way; a
patch that adds a runtime dependency will be turned down no matter how good the feature is.

```
src/server.ts      the CLI and the http routes
src/server/        git, workspace scanning, prefs, the live layer, the app window
src/client/        the browser side, bundled into public/app.js
src/shared/types.ts  the wire format both sides agree on
test/              node:test suites, run against real temporary repositories
```

## Working on it

```
git clone https://github.com/Filo6699/peekatgit && cd peekatgit
bun install          # devDependencies only: typescript, @types/node
node src/server.ts . --foreground
```

Node runs the TypeScript directly, so there is no build step for the server — edit and restart.
The client is bundled:

```
npm run dev          # rebuilds public/app.js on every change
npm run build        # the minified bundle CI checks against
```

`public/app.js` is **committed on purpose**: installing is a symlink and a `git pull`, with
nothing to build. So if you touch `src/client/`, run `npm run build` and commit the bundle in
the same commit — CI fails when it is stale.

## Before opening a pull request

```
npm run check        # tsc --noEmit, then the test suites
```

Tests use `node:test` and real repositories in a temp directory — nothing about git is mocked.
Add one for whatever you changed: a parser gets a unit test in `test/git.test.ts`, a route gets
an end-to-end test in `test/server.test.ts`.

Commit messages: one line, imperative, lower case ("skip binary files in the tree"). Keep the
diff to one idea.
