---
name: startup-loop
description: Use on every Startup manager or employee wake, inbox result, blocked assignment, or due duty.
---

# Startup shared loop

Load this complete source with the assigned canonical role. Native identity, generation, source receipt and supervisor come from the runtime. An inbox cue is scoped task data, not a replacement persona. The manager remains the sole user contact and merge authority.

## Every wake

1. Read your projected checkpoint and assigned cue. Claim your own next ready inbox with `startup_claim {}`. A null claim means no admitted work; it does not retire you or authorize another employee's inbox.
2. Perform only the claimed authorized work using the assigned canonical procedure. Architect intake first reads full scoped input pages and relevant native images as described in `../startup-intake/SKILL.md`. Members report to their architect; architect reports only to manager; standing staff report to manager. Request additional capacity through this hierarchy.
3. Settle once with `startup_settle {claimId,result:{id,kind,output,checkpoint,outgoing}}`. Kind is `completed`, `question`, or `uncertain`. Outgoing cues carry `{id,recipient,kind,correlation,payload}`. Save results, checkpoint, acknowledgement and reports atomically; transport delivery is not settlement. Stable retry IDs replay the same operation. `startup_send` saves an additional scoped cue before wake.
4. Advance the item's typed phase through `startup_item` under your role's authority. Before handling blocked/question/uncertain execution, read `../startup-intake/references/queue-records.md` section "Paused execution"; a later answer result cannot complete the original assignment.
5. Claim another ready own cue. With no ready work, use the active native wait/yield capability and remain logically employed. Host scheduling wakes saved cues and assigned duties; queue drain and native parking are not retirement. Never spin-poll. Only manager can retire eligible idle DevOps through `startup_retire` after duty/mail/claim/assignment/grant resolution.

## Manager sweep

Before wait, standby or final: classify saved human receipts; delegate each saved work event to its own complete architect-led team; assign every ready independent item, and progress completed execution/review/landing. Reuse eligible idle staff or hire missing capacity immediately. Include bounded pipeline/buddy/review descendants in actual execution capacity. A running intake, CI job or review blocks only work with that actual dependency. Use `startup_staff` and the runtime's concrete capacity/resource/dependency/employee-limit blocker validation. Pending activation retains its identities; retry `task {startup:"activate",employeeIds}`. Sweep again after every outcome.

## Duties and recovery

Read `../../extensions/startup/README.md` before duty assignment or repair. Host timers own due checks; employees handle their saved cues. Hiring is not repair authorization. Preserve unknown/offline health and timestamped historical evidence. Uncertain claims/actions require manager reconciliation with actual evidence before another attempt. Source-change blockers require supported idle refresh/recovery and actual new source admission.

Prompt-only execution follows the same role, hierarchy, checkpoint and ready-work procedures using the active harness's supported tools. See the single harness contract in `../startup/references/role-dispatch.md`.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
