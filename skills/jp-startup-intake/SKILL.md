---
name: jp-startup-intake
description: Capture and triage each Startup work event, including later requests and clarifications.
---

# Startup intake

The manager saves and classifies each event, captures its actionable passages and schedules independent ready work. Preserve the original input and stable event identity. Manager-led execution is enabled; capture or launch alone does not prove completion.

1. Use `startup_route` for saved input or `startup_intake` for explicit intake. Read all input pages with `startup_input {inputId,offset:0}` and follow `nextOffset`; retrieve relevant attachments with `startup_image {inputId,index}`. Do not treat a preview as the complete request.
2. Enumerate actionable passages. Give independent deliverables separate IDs; preserve prior request text for authorized amendments. Feedback on dispatched or terminal work becomes a linked follow-up. Capture screenshot complaints before interpreting rules.
3. Persist passages before lookup or clarification using `startup_capture {captureId,eventId,rows,receipt}`. Each row is `{id,expectedRevision,fields}`; a new row has a null revision. Use `NEEDS_DECISION` for incomplete work and record request, acceptance and concrete `blocked_on`. Map passages to IDs in the receipt. Stable retries must carry identical data; later edits use the current revision and a new capture ID.
4. Resolve procedure, repository, target, acceptance and actual dependencies. Queue ready items and start independent pipeline or hotfix runs without waiting for unrelated lookup or clarification. Ask only for missing decisions; use the PA when helpful. Preserve explicit user constraints and authorization.

The coordinator is the queue writer; do not replace queue files directly. Historical architect-led work retains its original assignment and recovery procedure in `references/queue-records.md`; do not create a crew for new manager-led work. Legacy imported rows remain quarantined unless an eligible cooperative transfer verifies the old cancellation and review history. Preserve source roots, execution history and review budgets.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
