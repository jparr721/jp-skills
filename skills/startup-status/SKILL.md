---
name: startup-status
description: Queue and bulletin view — renders queue rows, bulletin open items, sprint count to boundary, parked blockers; bulletin wipe archives done to memory, explicit only.
---

# Startup status (queue + bulletin view)

`startup status` — read-only view of the live queue. `startup bulletin wipe` — the only mutating subcommand, explicit only.

State lives under `<home>/startup/` — `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`. Never under `tmp/`. Sources: `queue.json`, `bulletin.md`, `memory.md`.

## Render

1. **Queue rows** - each `queue.json` row with `id, source, status, repo, target, branch, base, stack-mode, requested_roles`; older rows without `requested_roles` render `[]`. Open first, then in-flight, then blocked, then merged-closed (1 line each).
2. **Bulletin open items** — every `bulletin.md` item with `status: open`, with its source (`retro N` or intake handle).
3. **Sprint count** — merged count since last retro as N/5 to the `skill://startup-sprint` boundary.
4. **Parked blockers** — each `BLOCKED`/`NEEDS_DECISION` item with age since park and what it is blocked on.

## Bulletin wipe (explicit only)

`startup bulletin wipe` archives `done` bulletin items → `memory.md` (1 line each with proving handle) and clears them from `bulletin.md`. Done-with-handle items are never deleted any other way; wipe runs only on the explicit boss command, never automatically at drain, retro, or sprint boundary.

## Invariants

Read-only otherwise — status never mutates `queue.json`, `bulletin.md`, or `memory.md`. Open items stay open; only wipe touches `done` items.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
