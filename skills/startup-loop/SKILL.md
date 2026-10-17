---
name: startup-loop
description: Use on every Startup manager or employee wake, inbox result, blocked assignment, or due duty.
---

# Startup shared loop

Load this complete source with the assigned canonical role. Authenticated harness identity, generation, source receipt, Herdr pane and supervisor come from the coordinator. An inbox cue is scoped task data, not a replacement persona. Humans may use each pane directly; role and approval authority stay fixed. Manager owns final landing after the owning architect's gate. In Claude Code the tools are `mcp__startup__startup_*`; load them with ToolSearch `select:`.

## Every wake

1. Read your projected checkpoint and assigned cue. Claim your own next ready inbox with `startup_claim {}`. A null claim means no admitted work; it does not retire you or authorize another employee's inbox.
2. Perform only the claimed authorized work using the assigned canonical procedure. Architect intake first reads full scoped input pages and relevant native images as described in `../startup-intake/SKILL.md`. Members report to their architect; architect reports only to manager; standing staff report to manager. Request additional capacity through this hierarchy.
3. Settle once with `startup_settle {claimId,result:{id,kind,output,checkpoint,outgoing}}`. Kind is `completed`, `question`, or `uncertain`. Outgoing cues carry `{id,recipient,kind,correlation,payload}`. Save results, checkpoint, acknowledgement and reports atomically; transport delivery is not settlement. Stable retry IDs replay the same operation. `startup_send` saves an additional scoped cue before wake.
4. Advance the item's typed phase through `startup_item` under your role's authority. Before handling blocked/question/uncertain execution, read `../startup-intake/references/queue-records.md` section "Paused execution"; a later answer result cannot complete the original assignment.
5. Claim another ready own cue. With no ready work, wait in your resident OMP or Claude Code pane and remain employed. Saved cues arrive as OMP extension messages or Claude Startup wake notifications, never typed into the composer. Queue drain and native parking are not retirement. Never spin-poll. Only manager can retire eligible idle DevOps through `startup_retire` after duty/mail/claim/assignment/grant resolution.

## Manager sweep

Before wait, standby or final: classify saved human receipts; use `startup_delegate {eventId,developers}` for each saved work event; assign every ready independent item, and progress completed execution/review/landing. Whole finished-crew reuse follows `../hire/SKILL.md`; otherwise delegate a new crew. Coordinator root-turn slots are separate from each harness root's local helper capacity; there is no aggregate cross-root helper enforcement. A running intake, CI job or review blocks only work with that actual dependency. Use `startup_staff` and the runtime's concrete capacity/resource/dependency/employee-limit blocker validation. Pending activation retains its identities; retry `startup_activate {employeeIds}`. Sweep again after every outcome. New delegation/landing requires the mandatory PA to remain source-admitted and supervised.

## Duties and recovery

Read `../../extensions/startup/README.md` before duty assignment or repair. Coordinator timers own due checks; employees handle their saved cues. Hiring is not repair authorization. Preserve unknown/offline health and timestamped historical evidence. Uncertain claims/actions require manager reconciliation with actual evidence before another attempt. Source-change blockers require supported idle refresh/recovery and actual new source admission. A proven failed process uses manager `startup_replace {employeeId,evidence}` after reconciliation.

Observed Herdr idle/done transitions become durable system messages to manager; state alone never settles work or approves it. The watchdog measures semantic progress from claims, results, queue transitions and explicit blockers. Heartbeats, working animation and unchanged status are not progress. Stale assignments, unclassified input, idle workers with outstanding claims and missed manager/PA deadlines require durable alerts and explicit recovery; the watchdog grants no approval.

The PA stays resident between bounded scheduled checks. Scheduled idle is healthy; process loss or missed supervision degrades Startup and blocks new delegation/landing while independent existing safe work may continue. Coordinator loss is explicit offline/unknown state, never inferred success.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
