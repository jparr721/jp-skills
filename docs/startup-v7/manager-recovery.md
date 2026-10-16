# Manager recovery and bounded lifecycle alerts

## Usage

Resume the original manager transcript in its saved Herdr pane and named OMP profile. On `session_start`, Startup reconnects automatically, using the saved private runtime configuration. `/startup-retry` retries admission in that pane. A successful attachment displays `startup-manager-reconnected`. A failed attachment blocks technical tools and retries every five seconds.

`GET /health` reports `manager.connected` and `manager.lastPoll` separately from supervision. A stale authenticated manager poll degrades overall health. `readyForAdmission` permits the disconnected manager to authenticate while the coordinator itself remains available.

Use existing manager commands to reconcile uncertain claims with evidence, resolve assignments only when their outcomes are verified, and issue new assignments for unfinished work. `startup_finish_team` still requires captured intake, terminal owned items and no unresolved claims, assignments, grants or mail. `startup_retire` now accepts idle members of finished crews as well as idle DevOps employees. Manager and PA retirement remains prohibited. Preserve transcripts and records when stopping retired native processes.

## Problem and shape

The manager extension previously retained admission only in process memory. Resuming the native transcript exposed Startup tools without restoring its authenticated bridge. Herdr sequence updates also produced repeated completion messages, even when the employee remained idle or done. Healthy supervision therefore concealed an unavailable manager and a growing inbox.

The existing entry module now owns saved-root recovery. It verifies the native transcript header and canonical file, pane, profile, Startup and source roots, workspace and Herdr session before using saved credentials. It reuses the coordinator configuration, execution limit and owner generation. An unrelated root cannot inherit manager authority from its working directory.

The store owns observation deduplication. Idle and done share one quiescent episode. A sequence-only update advances the observation checkpoint without creating another manager alert. A new observed work/completion cycle still produces an alert. Superseded pending lifecycle alerts are acknowledged with durable `observationCompaction` receipts, retaining their original payloads and audit history. The newest pending alert per launch, employee and generation remains. Claimed mail, task reports, questions, assignments and settlement evidence are excluded.

Live acceptance also exposed a second amplification path: the native bridge previously enqueued a wake for each pending message. The bridge now sends one inbox wake per poll, containing the pending count, only when the native session is idle. Busy sessions inspect their durable inbox through their normal context and stop loop. Idle sessions with stranded queued messages can still wake. Durable messages remain individually claimable. Regression tests use 1,000 pending messages, an arrival during a busy turn and an idle session with stranded queued work.

## Synthesis decision

Selected the eager, exact-saved-root candidate because native session start already supplies the required identity and the existing bridge owns polling and execution gating. Adopted the alternative candidate's separation of coordinator admission readiness from manager connectivity, and its requirement that retirement preserve work history. A lazy gate on every native boundary would require a wider bridge refactor and duplicate authority discovery across events. A new retirement protocol with stop intents was unnecessary for this repair: existing guarded store operations plus verified maintenance process stops preserve the same identities and evidence.

Accepted limits: recovery requires the original transcript, pane, profile and managed Herdr integration. It does not silently promote another conversation. Reconciliation records uncertainty; it does not certify technical completion. Runtime idle/done observations never settle work.

## Verification

Regression tests first failed for ordinary manager resume, foreign-root gating, sequence-driven completion flooding, old backlog compaction, honest manager health and finished-crew retirement. Tests cover retry after a failed initial poll, stable credentials, timer shutdown, claimed-mail preservation and state/history retention.

Live Aspen acceptance is recorded in `aspen-manager-recovery-acceptance.json` after release installation, recovery and bounded progress observation.
