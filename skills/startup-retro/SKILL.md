---
name: startup-retro
description: On-demand retro — same procedure as the sprint boundary: scan outcomes since last retro, emit weaknesses, append rule deltas and bulletin items, compress memory.
---

# Startup retro (on-demand)

Same procedure as the sprint boundary (`skill://startup-sprint`), run on demand: `startup retro` mid-sprint, or at drain when fewer than `SPRINT_SIZE` items merged since the last retro.

State lives under `<home>/startup/` — `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`. Never under `tmp/`.

## Scan sources

Scan `memory.md` + ledger outcomes since the last retro. Look for:

- Repeated review findings (same reviewer flag across items).
- QA escapes (bugs found after merge, overlap breakage).
- Stalls (parked blockers, slow wakes, contention on files or resources).
- Assumption-misses (recorded assumptions that proved wrong).

## Outputs

1. **Weakness list** — report to the boss: each weakness with the items that evidence it.
2. **Rule deltas** — standing-rule fixes → append to `standing-instructions.md`.
3. **Bulletin items** — fix/improve work → append to `bulletin.md` as `{item, source: retro N, status: open}`.

## 64KB compress

After emitting outputs, compress `memory.md` to 64KB: closed items → 1 line each, decisions → `standing-instructions.md`/`bulletin.md`, truncate head. Keep open items, blockers, and live handles intact.

## Bulletin lifecycle

Fixed/verified bulletin items → `done` with the proving handle, never deleted. `startup bulletin wipe` archives `done` → `memory.md` and clears them; explicit only, never auto.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
