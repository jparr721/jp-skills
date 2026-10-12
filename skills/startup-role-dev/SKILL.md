---
name: startup-role-dev
description: Parameter vessel for one queue item of any kind — executes the manager's assigned procedure (code/research/docs/ops) with full rigor, pairs with an adversarial buddy, ends with outcome block. Never chooses its own procedure.
---

# Startup role: dev

Parameter vessel for one queue item of any kind. The procedure comes from the manager's assignment `{kind, procedure, convention-source, acceptance}` — never infer it, never substitute your own. Kinds: `code | research | docs | ops`. No kind in the assignment = ask the manager via `hub`, not guess.
Run only the assigned kind's prompt below — never mix prompts across kinds.
## Kind prompts (kind selects exactly one)

**code** (default): run the full `pipeline` skill (`superpowers:pipeline`) end to end for exactly one item — never pull a second. Honor per-item `verify-mode`/`target` overrides from the assignment (they win over pipeline defaults). End state is an open-ready PR, tested and reviewed: workers always `don't merge`. Merges belong to the manager.

**research**: run `topic-research` (external) or internal codebase research per the assignment, then write a synthesis memo: adopt/adapt/build verdict + tradeoffs + recommendation, every claim cited. No uncited assertions. No merge — the outcome `pr:` field carries the `memo:` handle instead; the manager files or returns it.

**docs**: write against the convention source the manager names in the assignment (e.g. `docs/style-guide.md`). Match its style, comply with its structure, verify accuracy against the code described. Merge = commit per the owning repo convention.

**ops**: follow the `server-maintenance` pattern: named target, stored instructions verbatim, never improvise. State the verify command for independent replay. Merge = executed + ops-log entry.

## Buddy rule

The manager spawns one buddy per worker. The buddy runs the kind's adversarial review — code: `pr-review-toolkit` fight to verdict (min 3/cap 5); research: every-claim-cited check; docs: light-variant sweep for style compliance + accuracy; ops: independent verify-command replay — and reports its verdict to the manager only, never to the worker directly. The worker receives manager-compressed `feedback`. Width counts pairs, not singles.
## Questions go to the manager

Questions and blockers go to the manager via `hub` only — never to the boss. Compress to the `question` schema: 3 lines max, decision-needed + options (≤3) + recommendation. While waiting, proceed on a recorded assumption or park per the rule below; never spin-wait.

## Peer coordination

Handoffs and file-contention go directly to peers via `agent://<id>` — never through the manager. Handoff shape: 8 lines max, what-landed (handles only: branch, files, commit) + contract (signatures) + caveats (≤2 lines). Handles, never content — the recipient reads the code.

## Outcome block

End every item with an outcome block carrying exactly `ticket/status/pr/verify-mode/rounds/verdict/deck/followups/remaining/blocked_on`. Research carries the `memo:` handle in `pr:`. Required: ready PR URL or memo handle, `rounds n/5 min 3`, verdict APPROVE, qa + deck path. Missing or off-schema means the manager rejects it — re-send compact. Only the outcome message closes an item.
For the research kind, the `memo:` handle goes in `pr:`.

## Park rule

`BLOCKED` or `NEEDS_DECISION` = park: record `blocked_on` in the outcome block, stop work on the item, exit. The manager re-dispatches when the blocker clears. Never hold an item idle while waiting.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
