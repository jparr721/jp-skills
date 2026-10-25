---
name: startup-intake
description: Use for each new Startup work event, including later requests, clarifications, multiple tasks and screenshot complaints; execution belongs to its assigned architect.
---

# Startup intake

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

The manager saves/classifies raw input and dispatches a fresh complete team for every distinct invocation. Only that team's assigned architect runs this procedure. Direct invocation in the manager context routes to team dispatch; it does not make the manager a technical intake worker. A retry reuses the original event/team.

## Capture then triage

1. Read `references/queue-records.md`. Claim your own architect-intake cue after full team readiness. `message.payload.raw` is bounded metadata: 512-character preview, original text length, attachment count and retrieval references. Use `startup_input {inputId,offset:0}` and follow `nextOffset` until the full request is read. Pages are at most 4096 characters. Retrieve relevant `startup_image {inputId,index}` native blocks; use attachmentCount to include relevant attachments beyond the first eight metadata refs. Never treat the preview as full intake.
2. Enumerate every actionable passage. Independent deliverables get separate IDs. Authorized amendments to identified undispatched rows retain IDs and earlier request text; feedback on dispatched/terminal work becomes a linked follow-up. Status/conversation alone creates no work row. A screenshot complaint requesting a fix is captured before interpreting standing rules.
3. Persist every passage before ticket lookup, feasibility or clarification through `startup_capture`. Incomplete work is NEEDS_DECISION with request, acceptance, blocked_on, intake_refs and requested_roles; unknown values may be null. Retain exact event identity and one receipt mapping all passages.
4. Resolve kind/procedure/acceptance using known repo/ticket context and recorded assumptions. For each ready row proceed with own-team execution immediately; another row's lookup or missing input is not a barrier. Capture subsequent row changes with current revision and a new stable capture ID. Keep unresolved rows and their concrete blocker visible.
5. Confirm the durable passage mapping and current outcomes to manager, then continue coordinating the team. Members report to you; report only to manager. Questions go through manager, while independent ready work continues.

| Outcome | Saved status | Requirement |
| --- | --- | --- |
| enqueue | QUEUED | Resolved kind/procedure/acceptance and required repo, target, convention or operation authorization |
| async-clarify | NEEDS_DECISION | Named missing scope/access/target/acceptance in blocked_on |
| reject-with-reason | REJECTED | Demonstrated infeasibility or unauthorized scope, preserving request and reason |

Kinds are code/research/docs/ops. Code acceptance names behavior; research names question/decision; docs names scope/convention; ops names target/mutation/independent verify. Preserve explicit canonical requested_roles from first capture. Requested DevOps coordination returns READY/NEEDS_INPUT/NO_ACTION before affected execution; coordination alone is not mutation permission.

## Boot ownership

`startup new` deterministic selection/root guidance happens before this team is dispatched; see `../startup/SKILL.md`. Architect can collect repo inventory, verification preferences and unresolved setup decisions as scoped intake. Preserve existing `.startup/config.md`, binding, queue and resource history; runtime queue writes use the existing serialized writer.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
