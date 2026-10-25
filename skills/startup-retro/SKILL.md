---
name: startup-retro
description: Use for requested Startup retros or a new five-merge boundary, with evidence-backed rule and bulletin updates.
---

# Startup retro

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Use selected Startup memory/ledger/completion evidence since the last recorded retro. Manager owns high-level governance; route new technical investigation through a fresh complete intake team. Independent teams and input capture continue during retro.

Inspect repeated review findings, QA escapes/overlapping flows, blockers/resource contention, assumption misses and oversized coding time. Distinguish coding from CI/review/block waiting using recorded evidence; do not reopen execution code/logs in manager context.

Return weaknesses with proving item handles. Append scoped rule deltas to standing instructions and improvement items to bulletin as open with retro source. Record the retro handle/boundary so the same outcomes are not processed twice. Technical work gets its own saved input and architect-led team.

Compress manager memory to 64KB while retaining open work, decisions, blockers and live handles. Summarize scanned completion reports with coding/wait/verdict/proof handles; preserve source reports and runtime audit history. Verified bulletin items become done-with-proof; only explicit bulletin wipe archives/removes them.

Sweep ready independent work before waiting. Queue drain means logical waiting, with persistent checkpoint/history.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
