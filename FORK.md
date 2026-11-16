# Michael's T3 Code fork

This checkout is a personal fork that Michael runs as his daily T3 Code. These rules apply on top
of AGENTS.md and win where they disagree. Michael wants no manual steps: do the git, build and
ship work yourself.

## Layout

| What                                         | Where                                                      |
| -------------------------------------------- | ---------------------------------------------------------- |
| Upstream (pingdotgg/t3code)                  | remote `upstream`                                          |
| Fork (michaeltangelo/t3code)                 | remote `origin`                                            |
| Upstream mirror, never commit to it          | branch `main`                                              |
| What Michael runs: upstream plus his patches | branch `mine`                                              |
| Upstream commit `mine` is built on           | ref `refs/fork/base`                                       |
| App builds, two slots                        | `~/code/t3code-slots/a` and `b` (detached worktrees)       |
| Launcher, sync and ship scripts              | `fork/` (copied to `~/code/t3code-slots/bin` on each ship) |
| State and logs                               | `~/code/t3code-slots/state.json`, `logs/`                  |

The taskbar shortcut runs `bin/launch.ps1`. It opens the last good slot, then runs `sync.ps1` in
the background. The sync moves `mine` onto the newest upstream preview tag (`v*-preview.*`) and
builds into whichever slot the app isn't running from. When the rebase conflicts or the build
fails, it starts a thread in this project to fix it. Each tag is attempted once.

## Hard rules

- Never edit, build in or check out anything under `~/code/t3code-slots`. The app runs from there.
- Never check out `mine` anywhere. Never move `mine` or `refs/fork/base` by hand: use `fork/ship.ps1`.
- To preview T3 Code while you work, run `pnpm dev` (or `dev:desktop` / `dev:web`) from your own
  worktree. Inside a worktree the dev runner keeps its data in that worktree's `.t3`. Never pass
  `--home-dir` or set `T3CODE_HOME` to `~/.t3`: that is Michael's real database.
- A build whose migrations are behind the live database is refused. The scripts enforce this.

## Making a change Michael asked for

1. Work in your thread's worktree, on a branch off `mine`.
2. Show it: run the dev UI from your worktree and send screenshots.
3. Iterate in the thread until Michael says to ship it. Don't ship before that.
4. Commit, run `git rebase mine` if `mine` moved, then `pwsh -NoProfile -File fork/ship.ps1`.
   It builds, typechecks, moves `mine` and makes the build the one that opens next launch. Tell
   Michael to restart T3 Code to see it.
5. Add a line for the patch under "Patches" below, in the same commit.

To undo a patch: `git revert` it on a branch off `mine`, then ship.

Changes meant for upstream go on a branch off `upstream/main`. Push it to `origin` and draft the
PR text, but ask Michael before opening the PR.

## Sync threads

A sync thread was started automatically and nobody is watching it. Don't ask questions. Follow
the message: rebase, resolve, check, `ship.ps1 -Sync <tag> -Expect <sha>`. Keep each patch's
intent. If one can't survive the new upstream, drop it and note why under "Dropped patches".

## Patches

The commits on `mine` beyond `refs/fork/base`, and why each exists:

- Fork tooling: `FORK.md`, `fork/`, and one line in `AGENTS.md` pointing here.
- Claude usage limits: read Session/Weekly windows from `unifiedWindows` on newer Claude CLIs (michaeltangelo/t3code#1).

## Dropped patches

None yet.
