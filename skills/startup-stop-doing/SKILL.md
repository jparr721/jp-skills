---
name: startup-stop-doing
description: Use for an explicit Startup standing rule or screenshot complaint that needs scoped interpretation and propagation.
---

# Startup stop-doing

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Resolve selected Startup first. A direct textual rule is recorded by manager with its explicit scope. A screenshot complaint requiring technical interpretation or a fix is saved as work and dispatched to a fresh complete architect-led team. Architect reads full input and native images through `startup-intake`; own QA examines repro and scope. Architect reports the proposed enforceable rule to manager.

Manager records the approved rule in selected `standing-instructions.md`, or `<bound_root>/.startup/<repo>/<role>.md` when explicitly repo/role-scoped. Preserve existing instructions and source-tag the new constraint. Report the rule and destination in one line.

Propagate via saved scoped cues: manager to affected architects/standing staff, architects to their members. Each acknowledges through settlement; future assignments carry the applicable source-tagged constraint. Bounded OMP `task` or Claude Code Agent review helpers receive their assigned procedure and scoped constraints. Automated worker messaging follows the hierarchy; direct human pane access does not change role authority.

A rule never replaces canonical persona authority or authorizes a resource mutation. New work from feedback follows full intake; live/completed item feedback becomes a linked follow-up where required by queue ownership.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
