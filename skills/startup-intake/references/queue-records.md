# Intake queue records

## State and ownership

Use the selected Startup's `<home>/startup/<name>/queue.json` and `ledger.md`. Resolve the name and legacy state through the `State` section of `../../startup/SKILL.md`. A later intake uses the manager's current selection; an item's repo does not select another Startup. The manager is the sole queue writer and serializes intake events, outcome updates, and recovery writes.

## Durable rows

Retain the existing fields: `id, source, status, repo, remote, target, merge-strategy, branch, worktree, base, stack-mode, report-handle, kind, procedure, convention-source, requested_roles`. New rows also carry:

| Field | Content |
|---|---|
| `request` | The user's task passage, with later amendments appended in order. Preserve earlier intent and redact credential values under the existing credential rule. |
| `acceptance` | Current completion criteria, or `null` while unresolved. Record any criteria derived from established context in the receipt. |
| `blocked_on` | Missing information, access, or rejection reason; `null` when ready. |
| `intake_refs` | Intake event/part references that created or amended this item. |

`source` remains origin metadata such as `prompt` or a ticket ID; it is not a replacement for `request`. A pending row has a real request and ID, with unknown repo, target, kind, procedure, or other fields set to `null`. Capture explicit role requests in `requested_roles` immediately, including on pending rows.

Statuses for intake are `NEEDS_DECISION` for captured unresolved work, `QUEUED` for ready work, and `REJECTED` for a recorded rejection. Existing execution and terminal statuses remain intact. Only ready rows may be dispatched; rejected or pending rows do not count toward merged sprint totals.

Preserve old IDs, statuses, terminal rows, and unknown fields. These additions are optional on legacy rows; do not bulk rewrite them. Before dispatching an old row without a reconstructable request or acceptance, recover the missing payload from an identified ticket, transcript, or receipt. If recovery is uncertain, retain the row and mark it `NEEDS_DECISION` with the missing payload named. Existing in-flight work continues under its existing assignment.

## Event identity and receipts

Use the harness's stable incoming message ID as the intake event reference. If unavailable, allocate a receipt ID at first capture and reuse it for retries of that same event. A later user message with identical wording is a distinct event unless it is explicitly identified as a retry. Each actionable passage gets an event/part reference, such as `evt-7/2`.

Persist the event reference and complete incoming request text in `ledger.md` before ticket lookups, feasibility work, or clarification. Apply credential redaction. Each passage then maps to an existing or new row through `intake_refs`. On replay, resume an incomplete receipt from those rows; a completed receipt returns its existing mapping. An event header alone does not mean intake is complete. If a queue write succeeded before receipt completion, recover the receipt from the rows instead of duplicating them.

After verification, append the completed receipt with one outcome for every actionable passage:

```json
{"ref":"evt-7","status":"complete","input":"<incoming request text>","items":[{"part":1,"id":"<queue-id>","outcome":"enqueue|async-clarify|reject-with-reason|amend","blocked_on":null}]}
```

An amendment to undispatched work keeps the ID, appends the new instruction to `request`, updates current acceptance, and adds its intake reference. Feedback on dispatched or completed work creates a new linked follow-up item; its request and receipt name the originating item. A status question produces no work row.

## Preserve, write, verify

1. Read the latest queue and matching receipts for every intake write. Allocate new IDs without reusing existing ones. Append captures and update only explicitly matched items.
2. Preserve all unrelated rows and fields. If the file changed since it was read, reload and reconcile before writing; do not overwrite a stale snapshot.
3. Validate the resulting JSON, write a temporary file in the selected state directory, then atomically replace `queue.json`. Keep the queue's existing JSON container shape.
4. Read the saved queue back. Verify every prior ID remains, unrelated values are unchanged, and every actionable passage has its expected row, request, status, and intake reference. Verify amendments and replay did not create extra items.
5. Complete the receipt only after that check. Confirm its item IDs and outcomes to the user before continuing dispatch or collection. Missing details are visible in the receipt and queue status.

If reading, writing, or verification fails, report the state path and affected event/tasks as an intake failure. Do not claim successful capture or switch silently to a different queue. Keep unfinished receipt work visible until it is recovered.
