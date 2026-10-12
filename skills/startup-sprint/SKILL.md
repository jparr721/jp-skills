---
name: startup-sprint
description: INTERNAL sprint boundary — every 5 merged items pause fan-out, run the retro procedure, compress memory to 64KB, resume. Never user-invoked; manager calls it.
---

# Startup sprint (INTERNAL)

> INTERNAL — manager-invoked only. Never user-invoked; the manager calls this at the sprint boundary. Retro wording lives in `skill://startup-retro`; this skill invokes it, it does not duplicate it.

## Boundary check

On each manager wake, check merged-count mod `SPRINT_SIZE` 5. When the count hits a multiple of 5, this is a sprint boundary: pause fan-out and run the procedure below before dispatching new items.

## Pause fan-out, run retro

Pause fan-out. Run the retro procedure by delegating to `skill://startup-retro`: scan `memory.md` + ledger since the last retro → weakness list → deltas to `standing-instructions.md`, items to `bulletin.md`. Do not restate the retro wording here; the retro skill owns it.

## 64KB compress

Compress memory to 64KB: closed items → 1 line each, decisions → `standing-instructions.md`/`bulletin.md`, truncate head. Keep open items, blockers, and live handles intact.

## Resume

Resume fan-out on the next queued items. Record the retro handle in the ledger so the next boundary scans only new outcomes.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
