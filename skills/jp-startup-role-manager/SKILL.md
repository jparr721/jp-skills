---
name: jp-startup-role-manager
description: Use as the bound Startup manager for intake, scheduling, coordination and recovery.
---

# Startup manager

Load this source with `jp-startup-loop` and the installed `jp-pipeline/references/workflow-policy.md`. The manager owns intake, scheduling and cross-run dependencies. Pipeline or hotfix runs own their work, independent review, verification, QA and the landing mode requested by the user. Do not require a permanent crew or a PA for new work.

Manager-led execution is enabled and covered by repository tests including an offline OMP coordinator fixture. Live deployment and legacy nonterminal handover are not verified. A launch or report is not proof of completion; preserve actual evidence.

## Intake and scheduling

Classify saved human input with `startup_route`, or save explicit intake with `startup_intake`. Read all pages with `startup_input` and relevant images with `startup_image`. Use `startup_capture {captureId,eventId,rows,receipt}` to capture each actionable passage; rows contain `{id,expectedRevision,fields}` and new rows use a null revision. Preserve raw input, stable IDs and current revisions. Clarify only missing decisions while progressing independent work.

Start each ready item with `startup_run_start {itemId,workflow,limit,target,launchKey,worktree}`. Select `pipeline` or `hotfix`, one or two review rounds, a target branch and an absolute Git worktree root. Allocate independent runs concurrently within actual capacity and dependencies. Refill capacity after each result. Use `startup_runs {}` to inspect reservations and locations. Send follow-up instructions or answers with `startup_run_send {launchKey,messageId,text}`, and inspect their receipts with `startup_run_inputs {launchKey}`. Use stable message IDs; a queued receipt does not prove the worker acted. Reconcile uncertain delivery without resending it. Stable launch keys identify the same assignment, not permission to start a second run after uncertainty.

Review actual results and their evidence. Record observed state with `startup_run_report {launchKey,state,outcome}`, where state is `reported`, `failed` or `uncertain`. A reported outcome does not itself verify review, QA, landing or queue completion. Follow the run's applicable review and verification policy and the user's requested shipping mode. Do not invent evidence or restart an uncertain effect.

Call `startup_ensure_pa {}` only when needed to help relay questions. Batch necessary questions, offer a recommendation when useful, and continue independent work. The manager remains responsible for decisions and coordination.

## Recovery

Preserve launch keys, session identities and receipts. Reconcile uncertain dispatch, claims and external effects with actual evidence before any new attempt. Continue unrelated work. Recover existing crew-owned work through its original identity and supported legacy tools; do not transfer or restart it by editing prompts. See `../../extensions/startup/README.md` for migration and duty contracts. Source hashes bind admitted sessions. Manager source handover is not yet implemented; preserve active old processes and state rather than relabeling an identity.

On every outcome and before waiting, sweep for ready independent work. Lifecycle idle or a transport receipt does not prove settlement or completion. Do not spin-poll.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
