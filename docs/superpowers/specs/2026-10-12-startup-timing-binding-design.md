# Startup timing + named binding — design

Date: 2026-10-12. Status: user-approved §§1–3, pending spec review.

## Problem

Manager cannot tell an oversized task from a slow system: zero timestamps
exist (`queue.json` rows carry `report-handle` but no times, outcome block
carries no timing, `ledger.md` is one compact row). Startup is also unbound:
no folder, no name lookup, no per-repo role overrides.

## Decision

Three additions, approach A throughout (trust-but-verify lite +
retro-driven split): internal `startup-time` reference, per-item completion
reports with a 60-min coding-time oversize flag, named startups bound to a
folder with root-level `.startup/` role overrides. Live interrupt (option C)
deferred until retro evidences repeat runaways; manager-recomputed timing
(option B) rejected — git-history brittleness across squash/rebase/multi-repo
plus firewall breach.

## §1 Timestamps + `startup-time`

`startup-time` is an internal reference (canonical command block, not a new
skill dir — avoids family-dir × symlink cost): single canonical command
`date -u +%Y-%m-%dT%H:%M:%SZ`, UTC ISO-8601 everywhere, no timers/live-spin.
PA tick reuses it for "current time" — no parallel clock path.

Manager stamps `dispatched_at` at fan-out (stored on the `queue.json` row),
`outcome_at` at outcome arrival (stored in the completion report),
`parked_at`/`unparked_at` on park/unpark (accumulated as `parked_mins` in the
completion report). Worker outcome block gains `coding_mins`
+ `waited_mins` (CI/blocked/review-wait split) + 2-line evidence snippet
(commits since dispatch, test/CI cycles). Manager sanity-checks only
(`coding_mins` ≤ wall clock, evidence plausible; mismatch → flagged, never
recomputed). Firewall intact: manager reads outcome+ledger only, never
code/diffs/logs; deep replay stays buddy's job.

## §2 Completion reports

Per-item `<home>/startup/<name>/completions/<id>.md`: dispatched/outcome
times, coding/wait split, parked intervals, evidence snippet, PR/memo handle,
verdict, deck path. `queue.json report-handle` points to it; ledger stays
1-line. `coding_mins > 60` → manager flags the report `OVERSIZE` and appends
an open bulletin item at outcome-collection time (retro-owned followup: next
similar intake splits smaller). Retro scans completions dir for optimization
signal; the retro procedure owns cleanup — compress each report to
1 line in `memory.md`, then delete the file.

## §3 Named startup + bound folder

New command `startup new <name> [--dir <path>]`: interactive setup, bounded —
list repos found in dir, one confirm for move-or-clone per repo so nothing
missed, ask local-test + production/CI verify once with per-repo overrides
only on deviation, skip/resume so creation never stalls on non-response.
Seeds DevOps `resources.json` locks from the answers.

Layout (`.startup/` at bound root holds config + overrides, never inside repos):

```text
foocorp/
  repoA/ repoB/ ...       # untouched .git, clean status
  .startup/
    config.md             # name, purpose, repo list, test/verify map
    repoA/qa.md           # e.g. "no local typecheck, RAM" — repoA only
    repoA/dev.md
```

State namespaces per name: `<home>/startup/<name>/` holds queue/ledger/
memory/standing/bulletin/resources/creds/completions plus `binding.json`
`{name, bound_root}`. `.startup/config.md` owns identity/prefs; global
`standing-instructions.md` owns behavior rules. Resolution: `startup
<prompt>` inside a bound dir resolves name via nearest `.startup/config.md`
(walk up); explicit `startup <name> <prompt>` works from anywhere.

Role overrides: `foocorp/.startup/<repo>/<role>.md` (role = dev/qa/devops/
architect). Precedence, last wins: global `standing-instructions.md` →
`.startup/config.md` prefs → `.startup/<repo>/<role>.md`. Missing file =
fall back to higher precedence; empty/whitespace-only file = same as missing
(no-override, never disable — explicit negatives are prose, e.g. "do not run
typecheck"). Readers: worker only — manager inlines the resolved file (or
"none") in the assignment block; buddy/architect/manager never read
`.startup/` directly. Writers: setup writes initial files; later edits
boss-only via scoped `startup stop-doing` (e.g. `stop-doing "QA: no local
typecheck in repoA"` → `.startup/repoA/qa.md`) or direct edit; workers
read-only at runtime. Git: foocorp root is a folder, not a repo — tracking
choice is the boss's; content never enters repo remotes.

## Record + message schema deltas

`binding.json` new per named startup. `queue.json` rows gain `dispatched_at`
(manager stamp); parked intervals accumulate to `parked_mins` in the report.
`report-handle` points at `completions/<id>.md` (which carries `outcome_at`).
Outcome block gains `coding_mins/waited_mins/evidence` (2 lines).
`completions/` dir new; `.startup/` new at bound root (`config.md` +
`<repo>/<role>.md`).

## Open risks

- Worker self-report gaming — mitigated by evidence snippet + wall-clock cap,
  not eliminated; buddy replay is the backstop.
- `coding_mins > 60` is a heuristic, not a proof of oversize — retro judges
  pattern across items, single flags never auto-split in flight.
- foocorp-root tracking is boss-managed; a future `git init` at root would
  sweep `.startup/` in — acceptable, content is boss-authored prefs.
