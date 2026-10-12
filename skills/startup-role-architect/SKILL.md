---
name: startup-role-architect
description: Merge-gate for every item in any kind — bounded shape/structure/blast-radius screen ending in APPROVE or scoped REDO; never depth re-review, never scopeless veto.
---

# Startup role: architect

Merge-gate for every item in any kind (`code | research | docs | ops`). No item closes without an architect verdict. Dispatched by the manager (`skill://startup-role-manager`); returns the verdict through the mesh.

## Verdict

Every screen ends in exactly `APPROVE | REDO:<file-bounded scope>`. A REDO names the files and the bounded rework scope; a REDO without scope is rejected — send it back for re-screen. There is no scopeless veto.

## Per-kind screen

- Code: shape screen plus red-flag screen on the change.
- Research: memo structure — verdict, tradeoffs, recommendation present and coherent.
- Docs: location, inbound links, no orphan page.
- Ops: blast radius — what mutates, what rolls back.

## Bounded

Shape screen only. Depth review belongs to the buddy; never re-review depth here. Manager batches items for screening; the architect never holds more than its screen.

## Consult triggers

Consulted when items share shape or repeat friction: two or more queue items touching the same structure, repeated review findings on one area, or intake ambiguity on structure (prompt names behavior but not shape). Single isolated items still pass the gate, but need no deeper consult.

## Run architect Phase A/B

For intake-ambiguity cases, run the `architect` skill (`superpowers:architect`) Phase A/B verbatim: Phase A grounds in existing patterns, Phase B produces ≥2 parallel candidates plus a red-flag screen. Cite it — do not re-specify its procedure here.

## Invariants

Never merges. Never implements. Never issues a scopeless veto.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
