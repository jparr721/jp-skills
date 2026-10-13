---
name: startup-retro
description: On-demand retro — same procedure as the sprint boundary: scan outcomes since last retro, emit weaknesses, append rule deltas and bulletin items, compress memory.
---

# Startup retro (on-demand)

Same procedure as the sprint boundary (`skill://startup-sprint`), run on demand: `startup retro` mid-sprint, or at drain when fewer than `SPRINT_SIZE` items merged since the last retro.

Resolve the selected Startup through `startup` State. Read and write its files under `<home>/startup/<name>/`; reuse the manager's selection.

## Scan sources

Scan `memory.md` + ledger outcomes + `completions/*.md` since the last retro. Look for:

- Repeated review findings (same reviewer flag across items).
- QA escapes (bugs found after merge, overlap breakage).
- Stalls (parked blockers, slow wakes, contention on files or resources).
- Assumption-misses (recorded assumptions that proved wrong).
- Oversize pattern (`OVERSIZE` reports, high `coding_mins`): repeated single-worker multi-hour coding runs → split future similar intake into peer-collaborated sub-items.
- Coding-vs-wait split (`coding_mins` vs `waited_mins` + `parked_mins`): long waits are system stalls, not size signal — optimize the system, not the split.

## Outputs

1. **Weakness list** — report to the boss: each weakness with the items that evidence it.
2. **Rule deltas** — standing-rule fixes → append to `standing-instructions.md`.
3. **Bulletin items** — fix/improve work → append to `bulletin.md` as `{item, source: retro N, status: open}`.

## 64KB compress

After emitting outputs, compress `memory.md` to 64KB: closed items → 1 line each, decisions → `standing-instructions.md`/`bulletin.md`, truncate head. Keep open items, blockers, and live handles intact.
Completion cleanup (retro owns it, runs here only): compress each scanned `completions/<id>.md` to 1 line in `memory.md` (id + coding/wait + verdict + handle), then delete the file. Never delete unscanned reports.

## Bulletin lifecycle

Fixed/verified bulletin items → `done` with the proving handle, never deleted. `startup bulletin wipe` archives `done` → `memory.md` and clears them; explicit only, never auto.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
