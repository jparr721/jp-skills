---
name: startup-status
description: Use for the selected Startup's queue, staffing, duty, bulletin and blocker view or explicit bulletin wipe.
---

# Startup status

Resolve selection through `startup`. Status is read-only except explicit bulletin wipe. The bound manager reads `startup_staff {}` and `startup_duties {}`; other personas receive scoped summaries via their supervisor. No PA all-staff API exists.

## Render

1. Runtime mode, actual source readiness, capacity/explicit ceilings, employee role/state, pending hires and activation errors, complete-team state. Distinguish installed/unbound/failed from bound runtime; skills-only is not persistence.
2. Canonical queue rows: ID/status/request/repo/target/base/branch/stack-mode/requested_roles, current revision and concrete blockers. Keep terminal rows visible. Legacy missing payload is unresolved; missing requested_roles behaves as `[]`.
3. Received input disposition/intake coverage, pending inbox/claims/assignments and recovery blockers. Unrelated unfinished intake is never a reason another ready team must wait.
4. Duties: supported configured/currentHealth/lastObservation/blocker fields. Show due information only from supported staff snapshot/assigned data. Runtime ONLINE/OFFLINE and current unknown/stale health remain distinct from timestamped historical JSON acceptance.
5. Open bulletin items, sprint merged count since recorded retro, aging BLOCKED/NEEDS_DECISION rows, unresolved legacy queue/lock ownership.

Native `/startup status` displays supported runtime staffing/duties. This skill adds queue, ledger, bulletin and memory context. Prompt-only status states its actual procedural limits using the single contract in `../startup/references/role-dispatch.md`.

## Bulletin wipe

Only an explicit `startup bulletin wipe` archives done-with-proof bulletin entries into memory and removes them from bulletin. Preserve open entries, proofs and unfinished work. Do not wipe at drain or sprint/retro automatically.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
