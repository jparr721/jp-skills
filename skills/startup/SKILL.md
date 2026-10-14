---
name: startup
description: Use to boot a named Startup, route later human requests, or invoke its queue commands.
---

# Startup

One selected Startup has one canonical manager and persistent employees. Read `references/role-dispatch.md` before role binding. The manager handles high-level intake disposition; an architect-led team performs every distinct technical intake invocation.

## Boot and selection

For native boot and installation read `../../extensions/startup/README.md`. Use `/startup new <name> [--dir <JSON-quoted-path>] [-- <work>]`, `/startup select <name> [-- <work>]`, or `/startup` for the nearest bound root. Root `AGENTS.md` is synchronously refreshed beside `.startup/` before asynchronous work. Existing user instructions survive one idempotent managed section; malformed/conflicting guidance blocks boot. Children retain their assigned role.

In prompt-only mode run the same deterministic writer before intake/build/dispatch: `bun <jp-skills-repo>/extensions/startup/src/boot.ts <home> <jp-skills-repo> <name> <bound-root>`. This initializes guidance and binding, not native staffing. Use actual absolute canonical paths; preserve existing configuration. Ask only for missing selection facts, never guess another Startup's ownership.

Selection remains fixed in the manager chat: explicit name resolves `<home>/startup/<name>/binding.json`; a bound directory resolves the nearest `.startup/config.md` with its matching binding. An item's repo never changes selection. Home is `JP_SKILLS_HOME`, then `XDG_CONFIG_HOME/jp-skills`, then `~/.config/jp-skills`. Preserve explicit limits; derive missing execution limits from actual harness capacity, including bounded review/buddy children.

## Every request

1. Load complete `startup-role-manager` and `startup-loop`. Native human input is saved before lookup. Manager uses `startup_route` for work/status/control/conversation/decision with a reason. Explicit procedure input uses `startup_intake`. Preserve raw input and stable event identity.
2. For each distinct work event immediately delegate `task {startup:"delegate",eventId,developers}`. Exactly one architect, one QA and one or more devs form a fresh assignment unit. Retry returns the original unit. Membership is immutable. The architect loads `startup-intake`, captures every passage, resolves technical detail and coordinates execution.
3. Reuse idle staff or hire missing roles and dispatch independent ready work while other teams triage, clarify, build or review. An incomplete team remains pending with its real blocker. Before wait/standby/final, repeat the ready-work sweep in `startup-loop`.
4. Team members report to architect; architect reports only to manager. Manager relays authorization and resource requests to shared DevOps, scales that pool, enforces gates and owns final landing. Technical code/diff/log inspection stays behind the execution firewall.

## Commands and state

| Intent | Procedure |
| --- | --- |
| `hire <role> <count>` or `startup hire` | `../hire/SKILL.md` |
| `startup status` | `../startup-status/SKILL.md` |
| `startup retro` | `../startup-retro/SKILL.md` |
| `startup stop-doing` | `../startup-stop-doing/SKILL.md` |
| `startup bulletin wipe` | Explicit archive procedure in status |

Native `/startup status` shows supported runtime staffing/duties; the broader skill renders queue/bulletin too. `startup-sprint` is internal, every five merged items.

State stays under `<home>/startup/<name>/`: runtime `staff.sqlite`, canonical `queue.json`, ledger, memory (64KB), standing instructions, bulletin, resource inventory, credentials and completions. Retain legacy IDs, unknown fields and receipts. Nonempty legacy `<home>/startup/queue.json` is recovery evidence; preserve it and import only with established ownership. Ambiguous ownership remains blocked.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
