---
name: startup-intake
description: Use when receiving new tasks, multiple requests, follow-up work, clarifications, or incomplete instructions in an active Startup conversation, including repeated intake calls while workers run or the manager is on standby.
---

# Startup intake

Capture every actionable request durably before assessing readiness. A request with missing details is a pending queue item. The manager runs intake in its own context.

## Every incoming turn

Apply intake to each later human message in an active Startup, including "also", "another thing", and additional requests during ongoing work. A direct intake invocation loads `startup-role-manager` in the current context and resolves the selected Startup first.

## Intake procedure

1. Before writing, read `references/queue-records.md`. Resolve the selected state, reload the latest queue, and identify this incoming event or its retry.
2. Enumerate every actionable passage. Independent deliverables get separate IDs. Clarifications and amendments to an identified undispatched item keep its ID; feedback on dispatched/completed work becomes a linked follow-up. Status questions and conversation without requested work create no row. Route explicit Startup control commands to their command procedure and acknowledge its result.
3. Record the incoming text and event reference, then persist each new work request as `NEEDS_DECISION`, with its `request`, `acceptance`, `blocked_on`, `intake_refs`, and explicit `requested_roles`. Unknown fields may be `null`. Capture all passages before ticket lookup, feasibility checks, or questions. A screenshot complaint requesting a fix is captured before any `startup-stop-doing` interpretation.
4. Triage each captured item using the table below. Use established conversation, binding, repo, and ticket context to resolve shorthand and derive acceptance. Record assumptions. Missing scope, access, target, kind, or acceptance keeps the item pending; capture remains complete.
5. Preserve and verify the queue using the record procedure. Finish a durable receipt mapping every passage to its item ID and outcome. Confirm queued IDs, pending IDs plus missing details, rejected IDs plus reasons, and amendments. Intake is complete only when all passages are accounted for in saved state; then the manager may resume work.

## Readiness outcomes

| Outcome | Saved state | Condition |
|---|---|---|
| `enqueue` | `QUEUED` | Kind, procedure, and per-kind acceptance are resolved; required repo/target/convention or operation authorization is known. |
| `async-clarify` | `NEEDS_DECISION` | Missing information or access. Name it in `blocked_on`, batch questions, and continue other items. |
| `reject-with-reason` | `REJECTED` | Demonstrably infeasible or outside the authorized scope. Preserve the request and explicit reason. |

Kind is `code`, `research`, `docs`, or `ops`: infer from the requested deliverable and record the inference; unresolved ambiguity remains pending. Acceptance names code behavior and area, the research question and decision, docs scope and convention, or ops target, mutation, and verify command. Resolve execution readiness after capture; each incomplete request stays visible.

## `startup new` interactive setup

`startup new <name> [--dir <path>]` (default dir = cwd). Bounded - never stalls:

1. List repos found in dir; boss confirms/adds/removes.
2. One confirm per repo for move-or-clone (local path vs remote URL); skip allowed, resume on next invoke.
3. Ask local-test command + production/CI verify path once; per-repo override only on deviation.
4. Write `<dir>/.startup/config.md` (name, purpose, repo list, test/verify map) and per-name state `<home>/startup/<name>/` with `binding.json` (`{name, bound_root}`). Seed DevOps `resources.json` locks from the answers.
5. Never write inside repo dirs; repo `.git` stays clean.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
