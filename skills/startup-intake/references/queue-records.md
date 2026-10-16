# Intake queue records

## Ownership and preservation

Use selected `<home>/startup/<name>/` throughout; an item's repo does not select the namespace. Runtime is the single canonical queue writer. Only the assigned architect captures its event's technical intake; manager retains high-level decisions/landing authority. All writes preserve old IDs, terminal rows, unknown fields, receipt history and the existing array/object container shape.

Retain `id, source, status, repo, remote, target, merge-strategy, branch, worktree, base, stack-mode, report-handle, kind, procedure, convention-source, requested_roles`. New intake rows also carry `request, acceptance, blocked_on, intake_refs`. Source metadata is not the task payload. Missing requested_roles on legacy rows behaves as `[]`; recover absent request/acceptance from identified evidence or leave NEEDS_DECISION. Preserve ambiguous legacy ownership and original files.

## Repository acquisition

Before assigning or executing repository work, resolve its checkout and authoritative remote from the saved row, linked ticket/PR, or the organization's repository metadata. Missing local repositories are setup work: clone the confirmed remote into the configured project workspace and continue. This applies to newly split service repositories and required cross-repository dependencies. Include the resolved remote, checkout path and required branch/base in the crew handoff.

Reuse an existing checkout after verifying its remote; preserve its changes, worktrees and branch. A path occupied by another repository requires a distinct checkout path. Verify a new clone's remote and requested ref before running its documented setup. A missing package/build output alone does not establish a missing repository: inspect workspace manifests and setup instructions first. Never derive a remote solely from a package name.

Clone within the assignment's existing scope and host authorization. Follow the named server's Ansible workflow where required. If the remote, ref or access cannot be resolved, report the exact missing input or command failure once through the architect, retain the checkpoint, and continue independent ready work. Retry only after the relevant condition changes.

## Scoped capture

Manager preserves an exact received event through `startup_route` work disposition, or `startup_intake {eventId,input,amendItemIds}`, before `startup_delegate {eventId,developers}`. Native receipt ID is the event ID. The same event retry is idempotent; identical later user wording is a new event/team.

Architect invokes:

```text
startup_capture {
  captureId, eventId,
  rows: [{id, expectedRevision, fields}],
  receipt
}
```

New rows use expectedRevision null; existing rows use current revision. Fields include nonempty request, acceptance, blocked_on and status QUEUED/NEEDS_DECISION/REJECTED. Preserve prior request text when appending an authorized amendment. Receipt maps every passage/part to ID and enqueue/async-clarify/reject-with-reason/amend outcome. The runtime preserves and journals queue replacement, revisions and receipt; read its result before claiming capture success. Same capture retry must be identical. Direct queue-file replacement is not the runtime procedure.

Capture all passages before technical lookup, then update and dispatch ready rows independently. Authorized amendments transfer ownership only under runtime event/team/revision rules; an old team cannot write afterward. Dispatched or terminal feedback requires linked follow-up. Existing execution remains under its assigned generation.

## Typed item phases

Every `startup_item` action requires `{requestId,itemId,expectedRevision,action}` and non-null evidence/proof. Read the returned revision after every action. Stable identical request retry replays; another transition uses a new ID.

| Action | Extra fields | Authority and effect |
| --- | --- | --- |
| assign | employeeId, evidence | Manager/own architect; QUEUED -> EXECUTING, own free dev |
| review | resultId, evidence | Assigned dev; its exact completed settled assignment result -> REVIEW |
| qa_assign | evidence | Own architect assigns own QA against saved dev result |
| qa | resultId, verdict APPROVE/REDO, proof | Assigned QA; exact completed settled QA output is proof |
| gate | verdict APPROVE/REDO, evidence | Own architect; APPROVE with matching QA proof -> READY_TO_LAND, scoped REDO -> QUEUED |
| decide | status, evidence | Manager/own architect BLOCKED/NEEDS_DECISION; explicit resolved resume to QUEUED |
| decide | status MERGED/DONE/REJECTED, evidence | Manager only; actual landing/acceptance required for MERGED/DONE from READY_TO_LAND |

Assignment `evidence` is the current attempt's executable directive, including file-bounded REDO scope and acceptance. The delivered `item-execution` cue carries it verbatim as `directive`, names `reportTo`, and retains original intake under `snapshot`. Execute the current directive within explicit user restrictions; an old review-only snapshot does not erase authorized implementation rework.

Settlement of a current item dev assignment automatically saves one linked `item-result` report TO its owning architect, including result ID, outcome and output. Receipt replay reuses that report. Completed settlement still requires the dev's `startup_item review` transition; the coordinator projects the exact saved result ID/current revision and retains a pending-review continuation until submission or an explicit item block. This report alone grants no QA, gate or landing approval.

Every accepted action increments revision, including QA assignment/proof. A normal flow is revisions 1 captured QUEUED, 2 assigned, 3 review, 4 QA assignment, 5 QA proof, 6 gate, 7 manager completion. `startup_finish_team` requires captured work and no unresolved owned item, mail, claim, assignment or grant.

QA APPROVE supplies proof; only the owning architect approves its gate and only manager approves final landing. Other architects, workers, PA and helpers cannot authorize merge progression. Herdr lifecycle state never settles claims or approves work. New delegation/landing requires source-admitted mandatory PA supervision.

## Paused execution

`startup_settle` question acknowledges its cue and settles its claim but leaves the assignment waiting. Uncertain leaves reconciliation. A later answer has another message/claim and cannot supply the original execution's required completed result.

1. Architect/manager records affected item NEEDS_DECISION or BLOCKED with `startup_item decide` and concrete evidence. Preserve waiting assignment and continue unrelated work.
2. Once actual state is known, manager uses `startup_resolve {assignmentId,evidence}` on the old assignment. For uncertainty first `startup_reconcile {claimId,evidence}`; then resolve its waiting assignment. Resolve/release held grants through their supported verified path. Never silently replay uncertain mutation.
3. Architect/manager records explicit QUEUED resume only from BLOCKED/NEEDS_DECISION after old claims/assignments and team grants resolve. Then `startup_item assign` with a new request ID creates a new attempt/message. The assigned dev must settle this new assignment completed and submit that exact result ID for review.

Capacity-blocked pending delivery is different: the cue is unclaimed and the coordinator retries admission when slots free. Keep existing event/team/employee IDs; do not settle nonexistent claims or hire duplicate retry identities. Manager `startup_block` evidence kinds are capacity, resource with target, dependency with prerequisite itemId, or employee-limit; the runtime validates current reality. Unrelated CI/intake/review is no blanket blocker.

## Coordinator ownership

The authenticated OMP extension sends commands to the coordinator, the exclusive state writer and lease owner. Preserve runtime receipts and journal recovery; direct queue-file writes are not an alternate execution path. Missing coordinator/OMP/Herdr readiness requires explicit recovery. Lifecycle observations and watchdog alerts preserve work history without manufacturing completion or authority.
