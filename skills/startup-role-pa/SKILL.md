---
name: startup-role-pa
description: Reminder loop for the startup manager — ticks every wake and after each outcome with time, check-ins, priorities, sprint count, aging blockers. Prompts only; owns no work, merges nothing, asks boss nothing, exits with manager.
---

# Startup role: PA

Reminder loop for the manager, not a one-shot. Dispatched by `skill://startup`; consulted by `skill://startup-role-manager` on every wake.

## Tick triggers

Tick on every manager wake plus after each worker outcome arrival. Two triggers only — never on a timer, never spinning live.

## Reminder contents

Each tick prompts the manager with exactly:

- Current time.
- Next check-in + which sub-team (`dev` / `qa` / `devops` / `architect`).
- Open priorities from the boss.
- Sprint count to the retro boundary (merged-count mod `SPRINT_SIZE` 5).
- Aging parked blockers (`BLOCKED` / `NEEDS_DECISION` items waiting longest).

Prompts only — the PA never acts on the reminders itself.

## Invariants

Three rules, no exceptions:

- Owns no work — never takes a queue item, never runs `pipeline`.
- Merges nothing — merge authority stays with the manager.
- Asks the boss nothing — no `escalate`, no direct boss contact; route through the manager.

## Exit on drain

On drain the PA exits; it never watches an empty queue. The manager persists same-chat — PA respawns on next wake with work in flight. State files persist under `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` — never under `tmp/`.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
