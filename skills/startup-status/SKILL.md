---
name: startup-status
description: Queue and bulletin view — renders queue rows, bulletin open items, sprint count to boundary, parked blockers; bulletin wipe archives done to memory, explicit only.
---

# Startup status (queue + bulletin view)

`startup status` — read-only view of the live queue. `startup bulletin wipe` — the only mutating subcommand, explicit only.

Resolve the selected Startup through `startup` State. Read `<home>/startup/<name>/queue.json`, `ledger.md`, `bulletin.md`, and `memory.md`. Surface nonempty legacy root queues and unresolved ownership conflicts as recovery blockers; status remains read-only.

## Render

1. **Queue rows** - render `id, status, request, repo, target, branch, base, stack-mode, requested_roles`. Use `payload unresolved` for old rows missing a request and `[]` for missing requested roles. Include pending and rejected rows, with their `blocked_on` reason; keep execution and terminal rows visible (1 line each).
2. **Bulletin open items** — every `bulletin.md` item with `status: open`, with its source (`retro N` or intake handle).
3. **Sprint count** — merged count since last retro as N/5 to the `skill://startup-sprint` boundary.
4. **Parked blockers** - each `BLOCKED`/`NEEDS_DECISION` item with age since park and what it is blocked on.
5. **Intake coverage** - received events whose intake receipts are unfinished, plus legacy recovery paths/counts. A status question creates no work row.

## Bulletin wipe (explicit only)

`startup bulletin wipe` archives `done` bulletin items → `memory.md` (1 line each with proving handle) and clears them from `bulletin.md`. Done-with-handle items are never deleted any other way; wipe runs only on the explicit boss command, never automatically at drain, retro, or sprint boundary.

## Invariants

Read-only otherwise — status never mutates `queue.json`, `bulletin.md`, or `memory.md`. Open items stay open; only wipe touches `done` items.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
