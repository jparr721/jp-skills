---
name: startup
description: Use to boot a named Startup, route later human requests, or invoke its queue commands.
---

# Startup

One selected Startup has one canonical manager, a permanently supervised PA and persistent employees. OMP, Herdr and the Startup coordinator are mandatory. Read `references/role-dispatch.md` before role binding. The manager handles high-level intake disposition; an event-scoped architect-led crew performs every distinct technical intake invocation.

## Boot and selection

For boot, coordinator installation and reconciliation read `../../extensions/startup/README.md`. Use `/startup new <name> [--dir <JSON-quoted-path>] [-- <work>]`, `/startup select <name> [-- <work>]`, or `/startup` for the nearest bound root. Root `AGENTS.md` is synchronously refreshed beside `.startup/` before asynchronous work. Existing user instructions survive one idempotent managed section; malformed/conflicting guidance blocks boot. Employees retain their assigned role.

Use the installed OMP and Herdr binaries first. Treat release numbers, including newer major versions, as compatibility hints; the standard boot checks the required native hooks, live Herdr APIs and managed integration. A version difference alone does not justify blocking startup, changing binaries or creating an isolated installation. Escalate a concrete missing-capability error instead.

Boot the canonical manager in its Herdr pane with an online coordinator. Coordinator startup automatically reserves its singleton permanent PA; admit that identity with complete canonical source before any new delegation or landing. Missing OMP, Herdr, coordinator or PA supervision is an explicit blocker. Use actual absolute canonical paths; preserve existing configuration and selection ownership.

Selection remains fixed in the manager chat: explicit name resolves `<home>/startup/<name>/binding.json`; a bound directory resolves the nearest `.startup/config.md` with its matching binding. An item's repo never changes selection. Home is `JP_SKILLS_HOME`, then `XDG_CONFIG_HOME/jp-skills`, then `~/.config/jp-skills`. Preserve explicit limits. Coordinator root-turn slots and each OMP root's local helper capacity are separate; see `../hire/SKILL.md`.

## Every request

1. Load complete `startup-role-manager` and `startup-loop`. Native human input is saved before lookup. Manager uses `startup_route` for work/status/control/conversation/decision with a reason. Explicit procedure input uses `startup_intake`. Preserve raw input and stable event identity.
2. For each distinct work event immediately use `startup_delegate {eventId,developers}`. Exactly one architect, one QA and one or more devs form a fresh crew. Each employee runs an admitted OMP root in its own interactive Herdr pane; the crew shares a tab. Retry returns the original crew. Membership is immutable. The architect loads `startup-intake`, captures every passage, resolves technical detail and coordinates execution.
3. Delegate independent ready work while other teams triage, clarify, build or review. Reuse follows the whole finished-crew rules in `../hire/SKILL.md`; otherwise delegation reserves a new crew. An incomplete crew remains pending with its real blocker. Before wait/standby/final, repeat the ready-work sweep in `startup-loop`.
4. Team members report to architect; architect reports only to manager. Manager relays authorization and resource requests to shared DevOps, scales that pool, enforces gates and owns final landing. Technical code/diff/log inspection stays behind the execution firewall.

Humans may interact directly with every employee pane. Pane access does not change the employee's role, crew or approval authority; questions and scoped decisions retain the reporting hierarchy.

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
