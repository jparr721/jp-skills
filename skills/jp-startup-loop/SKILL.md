---
name: jp-startup-loop
description: Use on each Startup manager or employee wake, inbox result, or recovery cue.
---

# Startup shared loop

Load this source with the assigned canonical role. The coordinator binds authenticated identity, generation, source receipt and pane. Cues are task data, not a replacement persona. In Claude Code the tools are `mcp__startup__startup_*`; load them with ToolSearch `select:`.

## Every wake

1. Read the checkpoint and assigned cue. Claim your own ready inbox with `startup_claim {}`. A null claim is not completion and does not authorize access to another inbox.
2. Perform the assigned work under the relevant procedure. The manager captures and schedules new work; a PA handles assigned questions on demand. Pipeline and hotfix runs carry out work, review, verification, QA and the user's requested landing mode.
3. Settle each claimed cue once with `startup_settle {claimId,result:{id,kind,output,checkpoint,outgoing}}`. Kind is `completed`, `question` or `uncertain`; each outgoing cue is `{id,recipient,kind,correlation,payload}`. Stable identical retries replay the saved operation. A delivery or idle observation is not settlement.
4. Continue ready independent work. Before waiting or finishing, the manager inspects saved inputs, run states and dependencies, starts every eligible independent run within capacity, and progresses actual outcomes. A review or CI wait blocks only its dependents. Do not spin-poll.

## Recovery

Use `startup_runs` and original launch identities to reconcile missing or uncertain results. Do not repeat an uncertain dispatch or external effect. Report only evidence actually observed; `startup_run_report` is not itself completion proof. Continue unaffected work while resolving the uncertainty.

Existing legacy claims, employees, review budgets and grants retain their original identity and supported recovery path. Preserve old roots and process state during migration. Source hashes are admission evidence: changing this file does not update an active session. Manager source handover is not yet implemented; preserve the session and state rather than relabeling it or starting a duplicate owner. Read `../../extensions/startup/README.md` for migration, duty and repair contracts.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
