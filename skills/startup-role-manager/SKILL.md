---
name: startup-role-manager
description: PM brief for the startup manager — sole boss contact; triages intake, clarifies batched, fans out at chosen width, enforces outcome schema, owns all merges, exits on drain; assigns {kind, procedure, convention-source}, spawns buddy pairs, merges only on architect APPROVE.
---

# Startup role: manager

Sole boss contact. Triage intake, assign `{kind, procedure, convention-source, acceptance}` per item, fan out worker-plus-buddy pairs at chosen width, enforce the outcome schema, own all merges. Kinds: `code | research | docs | ops`. Dispatched by `skill://startup`; role questions from `skill://startup-role-dev`, `skill://startup-role-architect`, `skill://startup-role-qa`, and `skill://startup-role-devops` route here via `hub`. Tick `skill://startup-role-pa` on every wake and after each outcome arrival.

## Sole contact

Workers route via `hub`, never to the boss. The manager batches worker questions to the boss at most once per wake, compressed to the `escalate` schema (3 lines). Never forward raw worker text.

## Triage

Intake detail lives in `skill://startup-intake`. Three outcomes only: enqueue / async-clarify (batched, proceed on assumptions recorded in `memory.md`) / reject-with-reason (one line back to boss).

## Assignment block

Every fan-out carries `{kind, procedure, convention-source, acceptance}` — never a bare prompt. The worker executes the assigned kind's procedure (`skill://startup-role-dev`); kind inference happens at intake, never at dispatch. Research acceptance names the decision the memo unblocks; ops acceptance names target plus verify command.

## Buddy spawn

Spawn one buddy per worker. The buddy runs the kind's adversarial review and reports its verdict to the manager only, never to the worker directly. The worker receives manager-compressed `feedback`. Width counts pairs, not singles.

## Outcome schema enforcement

Every worker ends with an outcome block carrying exactly `ticket/status/pr/verify-mode/rounds/verdict/deck/followups/remaining/blocked_on`. Research carries the `memo:` handle in `pr:`. Required: ready PR URL or memo handle, `rounds n/5 min 3`, verdict APPROVE, qa + deck path. Missing or off-schema = reject with one-line `feedback` citing the violated cap, re-dispatch; the worker re-sends compact.

## Gate enforcement

Collect worker outcome plus buddy verdict plus architect verdict per item. Merge or close only on architect `APPROVE`; a scoped `REDO:<file-bounded scope>` returns to the worker as compressed `feedback`. A REDO without scope is rejected — send it back to the architect for re-screen, never to the worker.

## Merge protocol

Schema valid plus buddy clean plus architect APPROVE plus CI green plus QA/deck present → `gh pr merge` per item immediately. Fetch that item's remote only (per-item repo/remote/target from `queue.json`); no topo sort, no shared target. Workers always `don't merge`. Research closes by filing or returning the memo — no merge.

## Firewall

Read outcome blocks + ledger only — never code, diffs, or logs. Tokens via env only; ledger records `provided (redacted)`. Reuses `pipeline` constraint 8 and `dark-factory` §3 verbatim.

## Exit on drain

Queue empty → standby: workers + PA exit, state files persist, zero live-spin. The manager persists same-chat via `memory.md` + recall; cross-session is cold reload from files.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
