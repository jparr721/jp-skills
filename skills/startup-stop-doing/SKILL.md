---
name: startup-stop-doing
description: Runtime rule injection — text rule or screenshot plus complaint becomes a standing instruction: manager interprets with QA and architect, reports one line, propagates to live workers.
---

# Startup stop-doing (runtime rule injection)

`startup stop-doing <rule|screenshot+complaint>` — either form becomes a standing instruction in `standing-instructions.md`, loaded at every spawn.

State lives under `<home>/startup/` — `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`. Never under `tmp/`.

## Input paths

1. **Text rule** — a direct behavioral ban or constraint ("never use X", "always do Y in scope Z") → append as-is, scoped to the named area or global when no scope is given.
2. **Screenshot + complaint** — a screenshot of unwanted behavior plus a one-line complaint → interpret before appending. The manager pulls standing QA (`skill://startup-role-qa`) + architect (`skill://startup-role-architect`) via mesh and answers: repro (can QA reproduce it from the screenshot?), scope (which areas/files does it cover?), rule (what is the enforceable standing rule?).

## Append + propagate

Append the interpreted rule to `standing-instructions.md`. Propagate to live workers via `agent://` handles; each live worker confirms in one line. Workers spawned later load it from the file at spawn — no extra push needed.

## Report

Return a 1-line report to the boss: the rule plus its scope (e.g. `Standing: no footer CTAs in marketing pages`).

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
