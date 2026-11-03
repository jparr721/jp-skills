# Task execution contract

Authoring template only: replace every angle-bracket slot before filing. A filled section is not a passed readiness gate. Delete these authoring instructions from the saved task. Use concise specifics, not filler; mark genuinely irrelevant sections `not applicable — <reason>`.

## Outcome and context

- Requested outcome: <specific observable result and who benefits>
- Current behavior/problem: <what happens today, with evidence>
- Desired behavior: <what changes, including important failure/empty states>
- Original request and governing decisions: <sources and concise summaries>

## Scope and boundaries

- In scope: <enumerated deliverables, affected repos/services/surfaces>
- Out of scope: <explicit exclusions and behavior that must remain unchanged>
- Constraints: <existing contracts, versions, compatibility, policy and design rules>
- Decision authority: <approved decisions and which internal choices the implementer may make>

## Research and starting points

- Source baseline: <repo and branch/revision, document version, or target/environment inspected>
- Traced flow: <entry point -> relevant definitions/callers -> data owner -> output>
- Starting files/symbols and adjacent examples: <verified locations and what each demonstrates>
- Existing tests/recipes: <verified test locations, commands and relevant CI coverage>
- Evidence: <revision-qualified path:line or permalink, finding established, limitations>
- Bug work: <observed/expected, minimal repro, safe inputs, logs/test evidence; cause proven or suspected>
- External contracts/prior art: <authoritative source and adopt/adapt/build decision if needed>

## Behavior and risk decisions

Answer each applicable question concretely. A heading or a checkmark is not an answer.

- Inputs/outputs: <shape, validation, defaults, units, limits and contract ownership>
- States and failures: <empty/loading/error behavior, recovery, timeout/retry/idempotency as relevant>
- Permissions and security: <actors, authorization boundaries, denied behavior, sensitive-data handling>
- Data and compatibility: <ownership, persistence, migrations/backfills, old clients/data, compatibility policy>
- Operational risk: <affected environments, authorization needed, observability, rollout/rollback or reason unnecessary>
- Performance/accessibility: <existing requirements and evidence; do not invent numeric targets>

## Question and decision ledger

| Question | Answer / unresolved decision | Evidence / decision-maker | Disposition | Unblock condition or non-blocking rationale and follow-up owner |
| --- | --- | --- | --- | --- |
| <one material question per row> | <actual answer or explicit missing decision> | <source or named decision-maker> | <resolved / blocking / non-blocking> | <specific condition, or why work may proceed and who follows up> |

## Dependencies and execution order

- Prerequisite: <exact task/service/access ID, owner, current state and evidence>
- Output consumed: <concrete artifact/interface/decision required from that prerequisite>
- Unblock condition: <observable event, not merely "ticket exists">
- Child/follow-up tasks: <IDs, responsibility and ordered relationships; each child has its own contract>
- Atomic execution outline: <grounded starting steps and constraints, not speculative line-by-line implementation>

## Acceptance and proof map

Each acceptance row defines an observable result, including the relevant negative/regression case. Cover every scoped requirement; give each criterion a stable ID.

| Criterion | Preconditions / action | Expected observable result | Verification command or independent check | Evidence to capture |
| --- | --- | --- | --- | --- |
| AC-1: <specific behavior/deliverable> | <concrete scenario> | <unambiguous result> | <repo-verified command or precise proposed test/manual procedure> | <test output, artifact, diff, screenshot, or readback> |

- Verification environment/data: <safe fixtures, services, access and who supplies them; no secrets>
- Command status: <which checks were actually run during research and results; planned checks explicitly not run>
- Completion proof: <required artifacts and independent checks; a code change alone is not proof>

## Readiness review

- Verdict: <READY / NEEDS_INPUT / BLOCKED / DRAFT; evaluate with the skill gate>
- Cold-start review: <reviewer or self-review, concrete gaps found and how each was closed>
- Remaining blockers: <every unresolved blocker, owner or explicitly unassigned, next action and unblock condition; "none" only when proven>
- Non-blocking follow-ups: <why they do not change this contract, owner and linked task where appropriate>
- Revalidation triggers: <source, scope, access or dependency changes that invalidate this review>

Saving agent: do not assert successful persistence inside this draft. After writing, read back the canonical task, verify this contract and relations, then return a separate receipt with exact ID/URL, actual workflow state and readback outcome. READY is not permitted until that check succeeds.
