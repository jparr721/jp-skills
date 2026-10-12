---
name: startup-role-dev
description: Per-item worker brief — runs one queue item through the full pipeline skill with don't-merge, routes questions to manager via hub, coordinates handoffs via agent handles, ends with outcome block.
---

# Startup role: dev

One queue item, full rigor. Run the assigned item through the `pipeline` skill (`superpowers:pipeline`) end to end. Dispatched by the manager (`skill://startup-role-manager`); questions route back there.

## One item, full pipeline

Run the full `pipeline` for exactly one item — never pull a second. Honor per-item `verify-mode`/`target` overrides from the assignment (they win over pipeline defaults). End state is an open-ready PR, tested and reviewed: workers always `don't merge`. Merges belong to the manager.

## Questions go to the manager

Questions and blockers go to the manager via `hub` only — never to the boss. Compress to the `question` schema: 3 lines max, decision-needed + options (≤3) + recommendation. While waiting, proceed on a recorded assumption or park per the rule below; never spin-wait.

## Peer coordination

Handoffs and file-contention go directly to peers via `agent://<id>` — never through the manager. Handoff shape: 8 lines max, what-landed (handles only: branch, files, commit) + contract (signatures) + caveats (≤2 lines). Handles, never content — the recipient reads the code.

## Outcome block

End every item with an outcome block carrying exactly `ticket/status/pr/verify-mode/rounds/verdict/deck/followups/remaining/blocked_on`. Required: ready PR URL, `rounds n/5 min 3`, verdict APPROVE, qa + deck path. Missing or off-schema means the manager rejects it — re-send compact. Only the outcome message closes an item.

## Park rule

`BLOCKED` or `NEEDS_DECISION` = park: record `blocked_on` in the outcome block, stop work on the item, exit. The manager re-dispatches when the blocker clears. Never hold an item idle while waiting.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
