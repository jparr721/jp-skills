---
name: jp-startup
description: Use to boot a named Startup, route later human requests, or invoke its queue commands.
---

# Startup

## Runtime preflight
Use a supported pane and the coordinator: OMP can use Herdr or Tern; Claude Code requires Herdr. Follow `../../extensions/startup/README.md` for backend-specific boot and identity requirements. Missing runtime readiness blocks Startup boot and dispatch; never bypass admission or substitute an in-process helper for an employee.

One selected Startup has one canonical manager, a permanently supervised PA and persistent employees. Read `references/role-dispatch.md` before role binding. The manager handles high-level intake disposition; an event-scoped architect-led crew performs every distinct technical intake invocation.

Shared workflow hierarchy, crew and review budget: `../jp-pipeline/references/workflow-policy.md`.

## Boot and selection

For boot, coordinator installation and reconciliation read `../../extensions/startup/README.md`. Use `/startup new <name> [--dir <JSON-quoted-path>] [-- <work>]`, `/startup select <name> [-- <work>]`, or `/startup` for the nearest bound root. In Claude Code start the manager with `startup-claude`; `/startup` is intercepted by the Startup bridge. The owner binds canonical role and loop sources through each native launch. Repository guidance stays repository-owned; boot writes its binding and runtime artifacts under the selected Startup root. Employees retain their assigned role.

Use the installed OMP or Claude Code and pane runtime binaries first. Treat release numbers, including newer major versions, as compatibility hints; standard boot checks required native and backend capabilities. A version difference alone does not justify blocking startup, changing binaries or creating an isolated installation. Escalate a concrete missing-capability error instead.

Boot the canonical manager in its supported pane with an online coordinator. Coordinator startup automatically reserves its singleton permanent PA; admit that identity with complete canonical source before any new delegation or landing. Missing harness (OMP or Claude Code), pane runtime, coordinator or PA supervision is an explicit blocker. Use actual absolute canonical paths; preserve existing configuration and selection ownership.

Selection remains fixed in the manager chat. Resolve `startupRoot` from absolute `STARTUP_ROOT`, or `<skills home>/startup/<name>`; the canonical `binding.json` there owns the selection. Without a name, the owner searches canonical Startup bindings for the nearest bound repository. An item's repo never changes selection. `JP_SKILLS_HOME` owns tooling, caches, worktrees and the default Startup roots. Preserve explicit limits. Coordinator root-turn slots and each harness root's local helper capacity are separate; see `../jp-hire/SKILL.md`.

## Every request

1. Load complete `jp-startup-role-manager` and `jp-startup-loop`. Native human input is saved before lookup. Manager uses `startup_route` for work/status/control/conversation/decision with a reason. Explicit procedure input uses `startup_intake`. Preserve raw input and stable event identity.
2. For each distinct work event immediately use `startup_delegate {eventId,developers}`. Exactly one architect, one QA and one or more devs form a fresh crew. Each employee runs an admitted OMP or Claude Code root in its own interactive pane; the crew shares a tab. Retry returns the original crew. Membership is immutable. The architect loads `jp-startup-intake`, captures every passage, resolves technical detail and coordinates execution.
3. Delegate independent ready work while other teams triage, clarify, build or review. On Herdr, reuse follows the whole finished-crew rules in `../jp-hire/SKILL.md`; Tern does not support reuse. Otherwise delegation reserves a new crew. An incomplete crew remains pending with its real blocker. Before wait, standby or final, repeat the ready-work sweep in `jp-startup-loop`.
4. Team members report to architect; architect reports only to manager. Manager relays authorization and resource requests to shared DevOps, scales that pool, enforces gates and owns final landing. Technical code/diff/log inspection stays behind the execution firewall.

Humans may interact directly with every employee pane. Pane access does not change the employee's role, crew or approval authority; questions and scoped decisions retain the reporting hierarchy.

## Commands and state

| Intent | Procedure |
| --- | --- |
| `hire <role> <count>` or `startup hire` | `../jp-hire/SKILL.md` |
| `startup status` | `../jp-startup-status/SKILL.md` |
| `startup retro` | `../jp-startup-retro/SKILL.md` |
| `startup stop-doing` | `../jp-startup-stop-doing/SKILL.md` |
| `startup bulletin wipe` | Explicit archive procedure in status |

Native `/startup status` (in Claude Code intercepted by the Startup bridge) shows supported runtime staffing/duties; the broader skill renders queue/bulletin too. `jp-startup-sprint` is internal, every five merged items.

State stays under selected `startupRoot`: `staff.sqlite`, canonical `queue.json`, ledger, memory (64KB), standing instructions, bulletin, resource inventory and completions. Preserve this owner's IDs and receipts. Boot is a hard cut: an old-format Startup (`binding.json` without `scope`) under home/startup and repository .startup files remain historical evidence, never an import source or alternate mutable namespace. OMP's own configuration and `mcp.json` in the Startup profile's OMP agent directory are shared native state; they do not select Startup authority.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
