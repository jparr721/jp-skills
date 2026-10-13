---
name: startup
description: Use when maintaining a Startup queue across turns, receiving later work requests in its active manager conversation, or invoking Startup queue commands.
---

# Startup

Persistent cross-turn queue drained by a singular manager. Enqueue prompts or Linear tickets across turns; the manager runs each item through full `pipeline` rigor (per `superpowers:pipeline`), merges per item, retros every sprint.

## Role loading

Before handling any Startup command, load the complete canonical `startup-role-manager` skill in the current manager context. Read and follow `references/role-dispatch.md` for harness selection and all role bindings. Intake (`startup-intake`) is a procedure run by the manager in that same context, not a spawned persona. A child role is not bound merely because its skill name appears in the assignment.

## Continuous intake

Once this conversation is the Startup manager, run `startup-intake` for each incoming human message before resuming dispatch or collection, including later requests while workers run or the manager is on standby. Complete its durable receipt for every work intent, clarification, or amendment. A later request does not need another `startup` prefix. Status questions route to `startup-status`; explicit control commands keep their own procedures.

## Dispatch

| Command | Effect |
|---|---|
| `startup <prompt\|SYT-xxx>` | Intake + triage, enqueue, ensure manager running |
| `startup new <name> [--dir <path>]` | Interactive bound-startup setup (see `skill://startup-intake`), writes `.startup/config.md`, seeds per-name state |
| `startup status` | Queue + bulletin view (see `skill://startup-status`) |
| `startup retro` | On-demand retro, same procedure as sprint boundary |
| `startup stop-doing <rule\|screenshot>` | Standing-rule injection (see `skill://startup-stop-doing`) |
| `startup bulletin wipe` | Archive done items, clear them; explicit only |

`startup-sprint` is internal — never user-invoked; the manager calls it at the boundary. Intake (`skill://startup-intake`) assigns kind (code/research/docs/ops), inferring when the boss states none.

## Manager persists, workers don't

Always-on via files, not live agents. Workers and the PA exit on drain; the manager persists same-chat: revival in the same chat reloads `memory.md` plus long-term recall (`xd://recall` for decisions/preferences) and continues with context intact — manager memory is the feature. Workers always spawn fresh behind the firewall. Cross-session (new chat) is a cold reload from files only.

## Loop (every manager wake)

1. Load state: `queue.json`, `memory.md` (64KB cap check), standing instructions, bulletin, resources.
2. PA tick: time, next check-in + sub-team, boss priorities, sprint count to boundary, aging parked blockers.
3. Run intake for all newly received or unfinished events: capture every work intent before readiness checks, then enqueue / batched async-clarify / reject-with-reason. Verify a receipt accounts for each intent. Pending requests remain in the queue; dispatch only ready `QUEUED` rows. Preserve explicit built-in role requests in `requested_roles`; missing on an older row means `[]`.
4. For ready `QUEUED` rows, dispatch every requested role and any DevOps environment/resource/operation adjudication before worker fan-out using the exact canonical binding. For explicit DevOps coordination, collect `READY`, `NEEDS_INPUT`, or `NO_ACTION` after intake and before the worker. `NEEDS_INPUT` parks that item; coordination does not authorize provisioning. Consult DevOps capacity and `resources.json` locks.
5. Fan out at manager-chosen width 1..cap (width counts worker+buddy pairs); each worker gets `{request, kind, procedure, convention-source, acceptance, base, stack-mode}` from its saved row, runs its kind procedure, `don't merge`. Same-repo/same-target code items chain (first on target, each next on prior branch); all else flat. Collect outcomes, dispatch architect for its required verdict and QA for per-kind/cross-item proof, enforce schema, merge green in stack order (flat items immediately; stacked chains bottom-up with child retarget after each parent merge), park blocked, and record assumptions in `memory.md`.
6. Sprint boundary: every `SPRINT_SIZE` (default 5) merged → pause fan-out, run `startup-sprint` retro, resume.
7. Queue empty → standby: workers + PA exit, state persists, zero live-spin.
8. Repeat on next wake (new invoke, same-chat revival, outcome arrival, command).

## Merge authority + async boss

Workers always `don't merge`; PRs sit open-ready. The manager verifies outcome schema + CI green + QA/deck + architect APPROVE (required for all kinds), then `gh pr merge` in stack order using that item's repo/remote/base from `queue.json` - flat items immediately, stacked chains bottom-up (parent first, then `gh pr edit --base` retarget of the child, re-green, merge); on stacking failure fall back to the flat target and record the reason. Research closes by filing/returning the memo. The boss is async by default: ambiguity -> record assumption, proceed; only true blockers (`escalate`: scope calls, missing auth, rebase conflicts) bubble synchronously. Boss feedback on dispatched or completed work becomes a new linked queue item; clarification of undispatched work updates its captured row through intake.

## Message schema (caps; shorter is better)

Every message carries `from`, `to`, `kind`, `item`, body. `update` worker→manager 5 lines (heartbeat only); `outcome` verbatim schema block (only message that closes an item; research carries `memo:` handle in `pr:` field); `question` 3 lines (≤3 options + recommendation, via `hub`); `feedback` manager→worker 5 lines (`ACCEPT|REDO:<scope>`); `handoff` worker→worker 8 lines (handles only, never content); `escalate` manager→boss 3 lines; `report` manager→boss 10 lines/item. Off-schema or oversize is rejected with a one-line `feedback`; workers re-dispatch compact. `update` only on wave boundaries and blockers.

## State

State namespaces per named startup: under `<home>/startup/<name>/`: `queue.json`, `ledger.md`, `memory.md` (64KB), `standing-instructions.md`, `bulletin.md`, `resources.json`, `creds/`, `completions/`, plus `binding.json` (`{name, bound_root}`). Intake owns the additive queue payload and receipt rules in `../startup-intake/references/queue-records.md`; retain older rows and unknown fields. Role dispatch receipts and results also go in `ledger.md`. Rows carry `dispatched_at`; `report-handle` points at `completions/<id>.md` (which carries `outcome_at`). Unnamed use resolves to `<home>/startup/default/`. NEVER `tmp/`. `MAX_PARALLEL` default 6 is a ceiling, not a target.

Resolution: an explicit `startup <name> <prompt>` selects that name. A Startup invocation inside a bound dir resolves the nearest `.startup/config.md` (walk up). Later messages and direct intake calls reuse the manager's selected name and bound root; with no active selection, resolve the bound cwd, then `default`. The item's repo never changes the selected Startup. Every queue reader and writer uses that selected namespace. Canonical clock: `date -u +%Y-%m-%dT%H:%M:%SZ` (UTC ISO-8601); the PA tick reuses it.

Legacy `<home>/startup/queue.json` is a recovery source, never a new write target. Surface its nonempty rows in intake/status. The manager may import rows into `default` when their unnamed ownership is established, or into a named Startup with matching ownership evidence. Preserve IDs, unknown fields, and the original legacy file. Conflicting IDs or uncertain ownership require a recorded recovery blocker and one batched question; do not silently discard, overwrite, or assign those rows to the current Startup.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
