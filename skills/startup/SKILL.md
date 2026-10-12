---
name: startup
description: Persistent cross-turn work queue — enqueue prompts or Linear tickets across turns, a singular manager drains each item through full pipeline rigor with standing architect/QA/DevOps roles, merges per item, retros every 5. Workers exit on drain; manager persists same-chat, state files persist.
---

# Startup

Persistent cross-turn queue drained by a singular manager. Enqueue prompts or Linear tickets across turns; the manager runs each item through full `pipeline` rigor (per `superpowers:pipeline`), merges per item, retros every sprint.

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
3. Triage intake: enqueue / batched async-clarify / reject-with-reason.
4. Fan out at manager-chosen width 1..cap (width counts worker+buddy pairs); each worker gets `{kind, procedure, convention-source, acceptance}`, runs its kind procedure, `don't merge`. Consult DevOps capacity and `resources.json` locks.
5. Collect outcomes: enforce schema, merge green per item immediately, park blocked, record assumptions in `memory.md`.
6. Sprint boundary: every `SPRINT_SIZE` (default 5) merged → pause fan-out, run `startup-sprint` retro, resume.
7. Queue empty → standby: workers + PA exit, state persists, zero live-spin.
8. Repeat on next wake (new invoke, same-chat revival, outcome arrival, command).

## Merge authority + async boss

Workers always `don't merge`; PRs sit open-ready. The manager verifies outcome schema + CI green + QA/deck + architect APPROVE (required for all kinds), then `gh pr merge` per item immediately using that item's repo/remote/target from `queue.json` — no topo sort, no shared target. Research closes by filing/returning the memo. The boss is async by default: ambiguity → record assumption, proceed; only true blockers (`escalate`: scope calls, missing auth, rebase conflicts) bubble synchronously. Feedback becomes new queue items, never inline rework.

## Message schema (caps; shorter is better)

Every message carries `from`, `to`, `kind`, `item`, body. `update` worker→manager 5 lines (heartbeat only); `outcome` verbatim schema block (only message that closes an item; research carries `memo:` handle in `pr:` field); `question` 3 lines (≤3 options + recommendation, via `hub`); `feedback` manager→worker 5 lines (`ACCEPT|REDO:<scope>`); `handoff` worker→worker 8 lines (handles only, never content); `escalate` manager→boss 3 lines; `report` manager→boss 10 lines/item. Off-schema or oversize is rejected with a one-line `feedback`; workers re-dispatch compact. `update` only on wave boundaries and blockers.

## State

State namespaces per named startup: under `<home>/startup/<name>/`: `queue.json`, `ledger.md`, `memory.md` (64KB), `standing-instructions.md`, `bulletin.md`, `resources.json`, `creds/`, `completions/`, plus `binding.json` (`{name, bound_root}`). `queue.json` rows carry `dispatched_at`; `report-handle` points at `completions/<id>.md` (which carries `outcome_at`). Unnamed legacy use resolves to `<home>/startup/default/`. NEVER `tmp/`. `MAX_PARALLEL` default 6 is a ceiling, not a target.

Resolution: `startup <prompt>` inside a bound dir resolves the name via the nearest `.startup/config.md` (walk up); explicit `startup <name> <prompt>` works from anywhere. Canonical clock everywhere: `date -u +%Y-%m-%dT%H:%M:%SZ` (UTC ISO-8601); the PA tick reuses it — no parallel clock path.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
