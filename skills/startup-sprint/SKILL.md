---
name: startup-sprint
description: Use internally at each five-merge Startup boundary to record retro and compress memory while independent teams continue.
---

# Startup sprint

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Manager-internal procedure. At each newly reached multiple of SPRINT_SIZE (default 5) merged items, run `../startup-retro/SKILL.md` once since its last recorded boundary. Record the retro handle and boundary in ledger; pending/rejected rows do not count as merges.

Keep intake capture and independent team dispatch progressing during this bounded governance work. A retro is not a global admission pause. Record a concrete dependency only for work actually affected by its decision. Run the shared loop ready-work sweep before wait/final.

Compress memory to 64KB: closed outcomes become one line with proving handle, retain decisions/standing instructions, open work/blockers/live handles. Preserve audit history in its persistent ledger/store. Resume normal coordination with the boundary receipt recorded.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
