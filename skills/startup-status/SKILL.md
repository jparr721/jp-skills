---
name: startup-status
description: Use for the selected Startup's queue, staffing, duty, bulletin and blocker view or explicit bulletin wipe.
---

# Startup status

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Resolve selection through `startup`. Status is read-only except explicit bulletin wipe. The bound manager reads `startup_staff {}` and `startup_duties {}`; other personas receive scoped summaries via their supervisor. No PA all-staff API exists.

## Render

1. Coordinator/harness (OMP or Claude Code)/Herdr readiness, actual source admission, root-turn slots/explicit ceilings, employee role/session generation/pane/state, pending hires and activation errors, event-crew hierarchy. Keep each harness root's local helper limit separate; no aggregate global helper usage is enforced. Distinguish reserved/starting/uncertain/failed from admitted. Show singleton automatically reserved PA source readiness, supervision deadlines and degraded blockers on new delegation/landing. Scheduled PA idle is healthy.
2. Canonical queue rows: ID/status/request/repo/target/base/branch/stack-mode/requested_roles, current revision and concrete blockers. Keep terminal rows visible. Legacy missing payload is unresolved; missing requested_roles behaves as `[]`.
3. Received input disposition/intake coverage, pending inbox/claims/assignments and recovery blockers. Unrelated unfinished intake is never a reason another ready team must wait.
4. Duties: supported configured/currentHealth/lastObservation/blocker fields. Show due information only from supported staff snapshot/assigned data. Runtime ONLINE/OFFLINE and current unknown/stale health remain distinct from timestamped historical JSON acceptance. Include durable manager lifecycle/progress alerts, observation gaps and missed manager/PA deadlines; idle/done never means accepted work.
5. Open bulletin items, sprint merged count since recorded retro, aging BLOCKED/NEEDS_DECISION rows, unresolved legacy queue/lock ownership.

Native `/startup status` (in Claude Code intercepted by the Startup bridge) displays supported runtime staffing/duties. This skill adds queue, ledger, bulletin and memory context. Use the mandatory runtime contract in `../startup/references/role-dispatch.md`; unavailable observations remain explicit unknown/offline state.

## Bulletin wipe

Only an explicit `startup bulletin wipe` archives done-with-proof bulletin entries into memory and removes them from bulletin. Preserve open entries, proofs and unfinished work. Do not wipe at drain or sprint/retro automatically.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
