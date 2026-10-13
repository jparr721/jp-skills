# Startup intake capture regression

## Scope

Patch release v5.0.1 fixes lost intake across successive human messages. Capture precedes readiness assessment. Incomplete requests remain queue items, undispatched amendments retain their IDs, and dispatch uses saved task text and acceptance.

The baseline is v5.0.0 commit `9f933d29cd0af444dd83dfe0f5bf1f54c2618bee`. Behavioral runs began before editing the skills. The release also preserves the subsequently published `.gitignore` change from `008363f`.

## Evaluation method

- Five independent fresh Codex subagent contexts per variant read complete, immutable Startup, manager, intake, and status sources plus required references. Each context received its own local fixture and fake canonical home.
- Samples 1-3 continued through actual later turns, an amendment, a separate research request, an identified retry, and a status question.
- The evaluator inspected saved queue and ledger files, compared prior rows including unknown fields, and checked fixture Git status. Agent success statements were not the sole evidence.
- Intake-only constraints prohibited execution, worker dispatch, human questions, external services, and fixture cleanup. Each fixture was retained until its observations were captured.
- Final wording aligns the main dispatch loop and role conformance example with the already-tested manager readiness rule and saved request field. Additional recovery/status checks use that snapshot. The released intake restores the existing `startup new` setup wording; setup was not invoked in these tests. Capture and record procedures are unchanged from the five-run variant.

## Reusable fixture

Create an isolated `JP_SKILLS_HOME`, a local Git repository `fixture-repo` with branch `main` and a reachable local `origin`, and a bound `.startup/config.md` selecting Startup `launch`, that repository, squash merges, and README conventions. README contains `## Install` and ordinary setup text.

Seed `<home>/startup/launch/queue.json` with legacy-schema rows A (`RUNNING`) and Z (`QUEUED`). Include unknown fields `owner_note: preserve-A` and `owner_note: preserve-Z`; neither row has the new intake payload fields. Keep their IDs, statuses, and fields intact during intake. Seed empty ledger, memory, bulletin, and standing instructions, resources `{}`, and a matching binding.

Load each source variant completely in a fresh agent context. Do not execute queued work. Preserve snapshots after each turn and inspect files independently.

### Event 1: competing work and incomplete second request

Stable message ID: `evt-1`.

```text
A is already running and CI is waiting. Queue a docs task in fixture-repo: change the README heading Install to Installation; done means only that heading changes. Also sort out production deployment later and coordinate with DevOps. I don't have the target host or verification command yet. Keep the current work going.
```

Pass criteria:

- Preserve A and Z exactly.
- Capture a ready docs item B with saved request, acceptance, and `evt-1/1`.
- Capture a distinct ops item C as `NEEDS_DECISION`, with its actual request, missing host/verification details, `evt-1/2`, and `requested_roles: ["startup-role-devops"]`.
- Complete one receipt accounting for both deliverables; status/continuation context creates no item.
- Write to the selected named queue. Pending C is not dispatched.

### Event 2: later amendment and separate new deliverable

Before this event, append a separately admitted docs item E to the queue with a saved spelling-review request, acceptance, `evt-interleaved/1`, and unknown field `owner_note: preserve-E`. This checks that the next intake rereads the queue instead of reusing its earlier snapshot; the fixture does not model simultaneous writers.

Stable message ID: `evt-2`.

```text
For the docs task from my last message, acceptance also includes keeping existing anchor links working. Also queue a separate research item in fixture-repo: compare REST and GraphQL for our public API; done means a cited recommendation with tradeoffs. No coding yet.
```

Pass criteria:

- Amend undispatched B in place, retaining its earlier request and adding the anchor criterion and `evt-2/1`.
- Create a separate research item D with the public API decision, cited recommendation/tradeoffs, no-coding constraint, and `evt-2/2`.
- Preserve unrelated A, Z, C, and E exactly. Complete a receipt mapping B/amend and D/enqueue.

### Retry and status

Redeliver the exact Event 2 text explicitly identified as a retry with the same `evt-2` ID. Then deliver a separate `evt-3`: `What's in the queue now?`

Pass criteria: reuse the completed mapping, create no extra items, do not repeat the amendment, leave queue bytes unchanged, and show pending C with its blockers and requested role.

### Legacy status boundary

In sample 4, add a nonempty `<home>/startup/queue.json` with two legacy rows: L with unknown ownership and a different A colliding with active A. Ask `What's in the queue now?` as read-only status.

Pass criteria: show the selected `launch` queue, surface both legacy recovery rows with ownership/ID blockers, and leave every state file byte unchanged. Do not import or discard ambiguous legacy work.

### Interrupted receipt recovery

In patched sample 5, seed `evt-4` with a received ledger header and an existing pending row R carrying `intake_refs: ["evt-4/1"]`, but no completed receipt. R's request and acceptance are already saved. Redeliver the same event as an identified retry:

```text
Queue a docs review in fixture-repo: review README setup links; done means a list of broken links with line references. Do not edit files.
```

Pass criteria: resume intake on R, preserve its ID and unknown fields, assess readiness, complete the receipt, and create no second review row.

## Observed baseline failures

- All five v5.0.0 runs admitted the docs task but omitted the deployment request from `queue.json`. The incomplete request appeared inconsistently in memory, ledger, or bulletin.
- Baseline sample 1 wrote: `Parked for async clarification outside the admitted queue because the production host and verify command are missing.`
- Baseline sample 2 wrote: `no queue placeholder admitted`.
- None of the five newly admitted docs rows stored `request` or `acceptance`; details lived elsewhere.
- All three later-turn samples created another docs-feedback row rather than amending the undispatched original. Sample 1 cited the v5.0.0 rule that feedback becomes new queue items.
- Baseline preserved old rows and the interleaved E, admitted research, and avoided duplicates on the explicitly identified retry. Those behaviors did not regress.
- Baseline status selected the named queue but excluded the legacy rows from its view without surfacing recovery blockers. The named-path ambiguity did not reproduce as a wrong-path write in the initial five runs.

## Results

All checks below inspect saved state. Counts are passing samples out of samples run.

| Check | v5.0.0 | v5.0.1 |
|---|---|---|
| Incomplete deployment captured as pending queue work | 0/5 | 5/5 |
| Docs request and acceptance stored in its row | 0/5 | 5/5 |
| A/Z IDs, statuses, and unknown fields preserved | 5/5 | 5/5 |
| Undispatched docs amendment retains its ID | 0/3 | 3/3 |
| Separate research item admitted | 3/3 | 3/3 |
| Interleaved item E preserved | 3/3 | 3/3 |
| Identified retry creates no duplicate rows | 3/3 | 3/3 |
| Status creates no work row | 3/3 | 3/3 |
| Legacy ownership/conflict surfaced in status | 0/1 | 1/1 |
| Legacy status leaves all state bytes unchanged | 1/1 | 1/1 |
| Interrupted receipt resumes existing R | Not run | 1/1 |

In all three fixed sequence runs, retry and status left every state file byte unchanged. All ten fixtures kept their repository working trees clean.

| Samples | v5.0.0 queue IDs | v5.0.1 queue IDs |
|---|---|---|
| 1 and 3 after sequence | A, Z, evt-1-docs, E, evt-2-docs-feedback, evt-2-research | A, Z, B, C, E, D |
| 2 after sequence | A, Z, evt-1-docs, E, evt-2-docs-anchors, evt-2-research | A, Z, B, C, E, D |
| 4 and 5 after first event | A, Z, evt-1-docs | A, Z, B, C |

The additional interrupted-receipt fixture began with R already present and ended with the same IDs: A, Z, B, C, R.

## Saved evidence

Fixed sample 1's deployment row carried these fields; unchanged execution fields are omitted:

```json
{
  "id": "C",
  "source": "prompt",
  "status": "NEEDS_DECISION",
  "request": "Also sort out production deployment later and coordinate with DevOps. I don't have the target host or verification command yet.",
  "acceptance": null,
  "blocked_on": "Missing production target host, verification command, and exact deployment operation/authorization. DevOps coordination is requested; provisioning or deployment mutation is not yet authorized.",
  "intake_refs": [
    "evt-1/2"
  ],
  "requested_roles": [
    "startup-role-devops"
  ]
}
```

Its later completed receipt mapped the amendment and new research independently:

```json
{
  "ref": "evt-2",
  "status": "complete",
  "input": "For the docs task from my last message, acceptance also includes keeping existing anchor links working. Also queue a separate research item in fixture-repo: compare REST and GraphQL for our public API; done means a cited recommendation with tradeoffs. No coding yet.",
  "items": [
    {
      "part": 1,
      "id": "B",
      "outcome": "amend",
      "blocked_on": null
    },
    {
      "part": 2,
      "id": "D",
      "outcome": "enqueue",
      "blocked_on": null
    }
  ]
}
```

## Source provenance and limits

Snapshot SHA-256 includes every Markdown file in copied `startup`, `startup-intake`, `startup-role-manager`, `startup-status`, `startup-role-pa`, and `cleanup` directories. Sort paths, then hash each repository-relative path, a NUL byte, file bytes, and another NUL byte.

| Snapshot | SHA-256 |
|---|---|
| source-v5.0.0 | `2dcbadf8fcdffe2b1579d9215630a73e3fd6f6843cc036295da69a04056e6ccd` |
| source-v5.0.1 | `5da44accc2d130cea585f7a2c81778ff69fbf585c0b33df5ed070c7280c16039` |
| source-v5.0.1-final (recovery/status tests) | `a92f798974c40297fa37bfb15e5ad12b16a9e3ce600db0bb78227a2b91d047c0` |
| Released skill subset | `b16c216164e09fb6dbf63b1b73477b5d5e6d8dcd260b031b7c50507c9b49ccd0` |

These runs verify behavior with full sources loaded in the current Codex subagent environment. They do not verify automatic skill discovery, every supported harness, actual DevOps dispatch, concurrent queue writers, production deployment, or a hard runtime guarantee. Legacy import and rejected-work scenarios received source review, not behavioral execution. Scratch fixtures were removed after recording the results.
