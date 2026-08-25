# Boardbash — rules for every plan

## Read first

- `CLAUDE.md` (repo root) and `.claude/clean-code.md` — the clean-code checklist in §9 governs
  every diff. `CLAUDE.md` §4.5 has a dedicated plan-runner section that *requires* the commit
  the spine's §5 describes; it is your authorization, not a restriction.
- For every `.ts`/`.tsx` file you open, check for a sibling `.md` with the same base name.

## Conventions

- Test files are `kebab-case.test.ts` / `.test.tsx`, co-located with the code. **Never** `*.spec.*`.
- All new file and folder names are **kebab-case**.

## Gates — run these before you commit

From the affected package directory:

```powershell
npm run test -- --findRelatedTests <changed-files...>   # fast feedback first
npm run test                                            # then the package's full suite
npx tsc -p tsconfig.json --noEmit                       # types - the runner ratchets the count
npm run lint                                            # where the package defines it - ratcheted too
```

## Browser check

**Default: the Playwright harness** in `packages/frontend-boardfest` — real Chromium,
deterministic, mounts real screens at DPR 1/2/3:

```powershell
npm run test:visual -- <spec-file>     # targeted
npm run test:visual                    # full sweep
npm run test:e2e                       # end-to-end flows
```

Then **`Read` the regenerated PNGs** under `tests/visual/__snapshots__/` and describe what you
actually see.

Baselines have a 2% `maxDiffPixelRatio` tolerance, so a stale baseline can pass a real
regression. When you intentionally change styling: delete the affected snapshot dir, re-run with
`--update-snapshots`, then `Read` the new PNGs to confirm they are correct before committing them.

The runner's visual ratchet retries specs twice, so an order-dependent failure that passes on a
retry counts as flaky, not failed. Run the sweep yourself first and compare against the list the
runner will use.

## Driving the live app

The runner brings up the backend on `http://localhost:3005` and the frontend dev server on
`http://localhost:1701/boardbash/` — no `npm run dev`, no `npm start` from you. After a plan that
changed `packages/shared` or `packages/frontend-shared`, the runner restarts the frontend itself:
Parcel resolves both through `node_modules` and its watcher never sees an edit there.

Drive it from a throwaway player, never on the browser a human is using — the app enforces one tab
per session, so an automation tab in the user's Chrome displaces their own:

```powershell
./scripts/launch-test-players.ps1 -Count 1 -Reset -StartId 1   # p1, uid 1, its own profile
./scripts/launch-test-players.ps1 -Close                       # when you are done
```

Each window runs on its own `--user-data-dir`, so it is a separate account with its own
localStorage and collides with nothing. Boot takes 30–60 s. Always `-Close` them before you
finish: a window left open holds the WebSocket session for its uid, and the next plan launching
that same player gets the "Opened in Another Tab" overlay instead of the app. The runner sweeps
any you leave behind after every plan, but that is a net, not your excuse.

Note which browser each tool reaches. The `mcp__claude-in-chrome__*` tools drive the Chrome
the Claude extension is installed in — the human's own, not these throwaway profiles. To
drive a *player*, attach over CDP: the launcher writes `<profile>/DevToolsActivePort`, and
`scripts/seed-test-player-identity.mjs` is the worked example of attaching to it.

## Showcase

Most of these plans come from a Linear ticket written by someone who is neither a developer
nor a product manager, and all they get back is a version number and a sentence. If your
change is one a person can **see**, take two to four screenshots of it and hand them over:

```powershell
node scripts/linear/ticket-demo-cli.mjs add --plan plans/<this plan file> --image "<path>" --caption "<what this picture shows>" --summary "<one line: what changed>"
```

- Run it **once per screenshot**, in the order they should be read. Before-and-after is worth
  two of them when the change is a difference rather than a new thing.
- `--summary` is required on the **first** shot and ignored after it — one line, in the
  language of the ticket, not of the diff.
- `--caption` is required on **every** shot. An unlabelled screenshot demonstrates nothing.
- At most six, and fewer is better.

To get a file to point `--image` at: `mcp__claude-in-chrome__computer` with
`action: "screenshot"` and `save_to_disk: true` returns the path it wrote. A Playwright PNG
from `tests/visual/__snapshots__/` is a file too, and is the right one to hand over when it
shows the change better than a live page would.

The command copies the picture into a gitignored staging directory and writes a manifest; it
reaches no network. A plan belonging to no ticket may still capture shots; they are simply
discarded. If the command refuses a shot, fix the caption or drop it and say so in the report.

## Off limits

**Production art and audio** live in the synced Dropbox folder (`CLAUDE.md` §0.6).

- **Dropbox is read-only, always.** Never create, edit, rename, move or delete anything under
  `C:/Users/conta/Dropbox/projects/nocap`. Copy *out* of it and never `Move-Item`, which deletes
  what it copies. This holds even when a file there is plainly wrong — report it, do not fix it.
- Prefer `node scripts/sync-production-assets.mjs --only <path>`. It maps `02_gfx` and `03_audio`
  onto `packages/frontend-boardfest/assets` for you and preserves timestamps. Run the command the
  plan names and commit what it copies; never sweep without `--only`.
- **Copying by hand is allowed** where the script cannot reach — a new asset, or anything outside
  those two areas. Copy it to the path the plan names and commit it like any other file.

## Gitignored, runner-owned

- `scripts/linear/.demo/` — your showcase screenshots. Deleting your own demo directory on the
  way out is not tidying up; it is throwing away the pictures the runner is about to post.
