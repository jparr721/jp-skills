---
name: jp-startup-status
description: Use for the selected Startup's queue, runs, duties, bulletin and recovery status or explicit bulletin wipe.
---

# Startup status

Resolve selection through `jp-startup`. Status is read-only except an explicit bulletin wipe. The bound manager can inspect `startup_runs {}`, `startup_staff {}` and `startup_duties {}`; show only supported observations and their timestamps.

## Render

1. Coordinator, harness and pane readiness, manager admission, capacity and actual source identity. Show a PA only when present; it is not a prerequisite for new work.
2. Queue rows with ID, status, request, repository, target, revision and concrete dependencies or blockers. Keep terminal rows visible. Show imported legacy rows and their quarantine separately.
3. Manager runs with item, workflow, launch key, saved state and location where available. Distinguish reservation, acceptance, failure and uncertainty. A launch, report, idle process or transport receipt is not verified completion or landing.
4. Saved input disposition, pending claims and unresolved effects, including legacy team and grant recovery when present. A stalled run does not prevent unrelated ready work.
5. Supported duties, current versus last observed health, open bulletin items and unresolved lock or queue ownership. Identify the lock owner when supported by actual evidence; show unknown when not known.

Report actual verification and completion evidence; do not infer it from tool availability. Preserve unknown or offline state rather than presenting historical observations as current.

## Bulletin wipe

Only explicit `startup bulletin wipe` archives done-with-proof bulletin entries into memory and removes them from bulletin. Preserve open entries, proofs and unfinished work.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
