# Startup skill family — design

Date: 2026-10-12. Status: user-approved sections §1–§5, pending spec review.

## Problem

`dark-factory` ships a whole Linear epic: requires epic parent, DAG/waves,
topo-order merge, epic close + backfill poll. Disparate queue (free-form
prompts, loose Linear tickets, mixed repos) has none of that: no parent, no
deps, no shared target. Forcing a fake epic is scope creep. Gas-town behavior
wanted: enqueue prompt after prompt across turns, orchestrator drains in
background, boss sees finished product.

## Decision

New skill family `startup/*`: persistent cross-turn queue, singular manager as
sole boss contact, full `pipeline` rigor per item, standing cross-item roles
(architect, QA, DevOps, PA loop), count-based sprint with auto-retro +
bulletin. Family of skill dirs (not single dir): each agent invokes its role
skill directly via `skill://`. Cost accepted: N dirs × 5 symlinks + README
rows + lockstep versioning.

Rejected: single `skills/startup/` + `roles/*.md` (role briefs deserve direct
invocation); queue-mode inside `dark-factory` (epic/DAG/topo assumptions
wrong); monolith SKILL.md (past ~500-word supporting-file threshold).

## §1 Layout + lifecycle

```text
skills/startup-role-manager/     # PM prompt: triage, clarify, fan-out, enforce
skills/startup-role-pa/          # manager's assistant: reminder loop (NEW §5)
skills/startup-role-dev/         # per-item pipeline-runner (≈ dark-factory §6)
skills/startup-role-architect/   # standing cross-item design reviewer
skills/startup-role-qa/          # standing cross-item QA, usability mandate
skills/startup-role-devops/      # adjudicator: env, resources, creds, cleanup
skills/startup-intake/           # intake protocol: feasibility, per-item record
skills/startup-sprint/           # INTERNAL: sprint boundary check + auto-retro
skills/startup-retro/            # on-demand retro (same procedure as auto)
skills/startup-stop-doing/       # text rule OR screenshot+complaint → standing rule
skills/startup-status/           # queue + bulletin view; wipe explicit only
```

`MAX_PARALLEL` default 6 (inherits `dark-factory`); override at enqueue.

Commands are first-token: `startup <prompt|SYT-xxx>` enqueue + ensure-running,
`startup status`, `startup retro`, `startup stop-doing <rule|screenshot>`,
`startup bulletin wipe`. `startup-sprint` never user-invoked.

Always-on via state files, not live agents: nothing survives an empty queue.
Manager + PA + workers all exit on drain; state files persist; next `startup`
invoke reloads and continues. Idle = exit to standby, never spin-wait — no
wake primitive exists and live-wait burns context. Width is manager-decided
1..cap (`MAX_PARALLEL` 6 is ceiling, not target) based on item independence,
`resources.json` locks, DevOps capacity.

## Loop structure (every manager wake)

1. Load state: `queue.json`, `memory.md` size check (cap 64KB), standing
   instructions, bulletin, resources.
2. PA tick: time, next check-in + sub-team, boss priorities, sprint count to
   boundary, aging parked blockers.
3. Intake triage: new prompts/tickets → feasibility/doability → enqueue,
   batched async clarify, or reject-with-reason.
4. Fan-out at manager-chosen width; workers run full `pipeline`, `don't merge`.
5. Collect outcomes: schema enforce, merge green per-item immediately, park
   blocked, record assumptions in `memory.md`.
6. Sprint boundary: every 5 merged → pause fan-out, `startup-sprint` retro,
7. Queue empty → standby: ALL agents exit (manager, PA, workers), state files persist, zero live-spin. Next `startup` invoke — including a new message in the SAME chat session after walk-away — reloads state and resumes. Revival is reload, never resume: no prior agent context carries over.
8. Repeat on next wake (new invoke, same-chat revival message, outcome arrival, command).

## Repeatable intake criteria

Queue-worthy = one unit of work with statable acceptance: Linear id, prompt
naming behavior + affected area + acceptance, or screenshot + complaint
(`stop-doing` path interprets into acceptance via QA + architect mesh).
Triage outcomes only: enqueue / async-clarify / reject-with-reason. No
criteria → not queued, returned to boss in one line.

Lifecycle: invoke → manager loads state, triages intake, enqueues, fans out at manager-chosen width → drain → ALL agents exit, state persists, standby.
Next invoke reloads and continues. No agent survives drain.

## §2 Roles + comms

Manager: sole boss contact. Loads queue + standing-instructions, triages feasibility/doability, clarifies batched when ambiguous, enforces outcome schema, owns all merges, exits on drain (no survivors).

Worker (dev brief): one item, full `pipeline` with `don't merge` + per-item
`verify-mode`/`target` overrides. Questions/blockers → manager via `hub`
only, never boss. Handoffs + file-contention → peers directly via
`agent://<id>`. Ends with outcome block: ready PR URL, `rounds n/5 min 3`,
verdict, `qa + deck path`, followups, remaining, blocked_on.

Architect: standing, cross-item. Consulted at intake when items share shape or
repeat friction. Runs `architect` Phase A/B verbatim (parallel candidates,
red-flag screen). Advisory via mesh; never merges, never blocks alone.

QA: standing, cross-item regression watch. Consumes per-item decks, flags
overlap breakage. Per-item proof still inside each `pipeline` Step 9 — never
replaces it. Usability mandate (§5): load real app/preview, click changed
flows, screenshot proof into deck; no mockups.

DevOps: adjudicator (§5). Provisions env per boss instruction, tracks
resources in `resources.json` (lock before provision), keeps creds cache,
cleans worktrees post-merge only after deck copy-out verified.

Firewall: manager reads outcome blocks + ledger only, never code/diffs/logs.
Token via env only, `provided (redacted)` in ledger. Reuse `pipeline`
constraint 8 (supervisor sole contact) + `dark-factory` §3 verbatim.

## §3 Persistence + merge authority + async boss

All state under `<home>/startup/` (`$JP_SKILLS_HOME`, else XDG, else
`~/.config/jp-skills`). NEVER `tmp/` — `cleanup` Step 1 wipes `tmp/<skill>/`
every run, so drain-to-standby would destroy the queue.

- `queue.json` — `{id, source: prompt|SYT-xxx, status:
  QUEUED|RUNNING|PR_OPEN|MERGED|BLOCKED, repo, remote, target,
  merge-strategy: squash|merge per repo convention, branch, worktree,
  report-handle}`. Per-item repo/target: disparate queue means disparate
  remotes; manager fetches that item's remote only, never assumes single
  `TARGET_BRANCH`.
- `ledger.md` — one compact row per item + outcome handles.
- `memory.md` — append-only session log, capped 64KB; retro compresses then
  truncates head. Size check on every manager wake.
- `standing-instructions.md` — `stop-doing` rules + retro deltas, loaded at
  every spawn.
- `bulletin.md` — retro backlog `{item, source: retro N, status: open|done}`.
- `resources.json` — `{ports, previews, worktrees, creds-ref} held-by item`.
- `creds/` — per-target records (preview auth, seeded accounts, tokens).
  Plaintext for now (boss-approved); risk: shared-machine read exposes them.
  Never in ledger/outcome/Linear. Later mitigation: manager-redacted handles.

Merge: workers always `don't merge`. PRs sit open-ready; manager verifies
outcome schema + CI green + QA/deck, then `gh pr merge` per item immediately.
No topo sort, no shared target required.

Async boss: manager treats boss as async by default. Ambiguity → record
assumption in `memory.md`, proceed; only true blockers bubble synchronously
(scope call affecting acceptance, missing/expired auth, structural rebase
conflict). Boss sees finished product + final report; feedback becomes new
queue items, never inline rework.

## §4 Sprint, auto-retro, bulletin

Sprint = count-based: every `SPRINT_SIZE` merged items (default 5, override at
enqueue) manager pauses fan-out on that boundary, runs `startup-sprint`
(retro procedure), resumes. No wall-clock daemon exists — count checked on
each manager wake. `startup retro` = on-demand same procedure mid-sprint.

Retro: scan `memory.md` + ledger outcomes since last retro — repeated review
findings, QA escapes, stalls, assumption-misses → weakness list +
standing-rule deltas. Deltas → `standing-instructions.md`; fix/improve items
→ `bulletin.md` with `{item, source, status: open}`.

Bulletin: `startup status` includes open items. Fixed/verified → `done` with
proving handle, never deleted. `startup bulletin wipe` archives `done` →
`memory.md`, clears them. Explicit only, never auto.

`startup-stop-doing <rule|screenshot+complaint>`: manager pulls QA +
architect via mesh, interprets (repro? scope? rule?), returns 1-line report +
appends to `standing-instructions.md`, propagates to live workers.

## §5 QA stack, DevOps state, PA loop

QA stack locked: Playwright (app/preview usability: load real flows, click
through, screenshots into deck) + Storybook (unreachable states, edge cases,
component proof on actual changed files). Every per-item Step 9 uses both;
outcome missing either = protocol violation, manager rejects.

DevOps: expects clear direction; tracks boot `cwd` context like
`server-maintenance` slug records (boot context recorded at intake; queue
carries per-item repo). `resources.json` lock before any provision —
`MAX_PARALLEL` workers race otherwise. Deck copy-out verified before any
worktree removal (inherits `dark-factory` §5.6 failure mode).

PA (`startup-role-pa`): reminder loop, not one-shot, lives only while manager lives. Each tick (every manager wake + after each outcome): current time, next check-in + which sub-team (dev/QA/DevOps/architect), open priorities from boss, sprint count to retro boundary, aging parked blockers. Owns no work, merges nothing, asks boss nothing — prompts only. Prevents stall-blindness. On drain PA exits with manager — never watches an empty queue.

## Open risks

- Plaintext `creds/` — accepted for now, revisit with redacted-handle scheme.
- Family-dir versioning drift — mitigate via lockstep release + README row
  per skill + `upgrading-jp-skills` relink coverage.
- `startup-sprint` boundary check relies on manager wake; long-idle queue
  with < SPRINT_SIZE unmerged items never retros — acceptable, retro fires on
  next drain or on-demand.
