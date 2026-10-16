# Startup prompt caching and token-volume investigation

The V7 bridge changed the system prompt and the first conversation message whenever a checkpoint or claim changed. This made routine supervision expensive to repeat. The fix keeps the verified role/loop instructions static and appends only live state at the end of the model context. No coordinator/store migration or business-state rewrite is required.

## Measured Aspen volume

The 2026-10-16 audit read 193 native JSONL files in the `sythelabs-v7` OMP profile, spanning its retained session history. It counted 34,491 unique assistant usage records, with zero duplicate usage records and zero parse failures.

| Role | Processed tokens | OMP-recorded cost |
| --- | ---: | ---: |
| QA roots | 3,485,926,310 | $11.56 |
| Architect roots | 1,617,848,383 | $11.55 |
| Dev roots | 1,162,099,773 | $6.14 |
| PA | 814,013,644 | $65.97 |
| Manager | 440,907,585 | $16.40 |
| Other native sessions | 164,913,153 | $2.37 |
| Total | 7,685,708,848 | $113.99 |

The total includes 6,689,256,967 cache-read tokens, 986,757,022 input tokens and 9,694,859 output tokens. These are native usage records, not an independently reconciled billing statement. They account for this profile only, not every host or profile in the user's approximate 10B total. The actual failed Aspen calls identify an OpenRouter key's $100 weekly budget, not the separate Codex allowance.

The harness produced 56,172 startup-cue messages and 11,412 turn-blocked messages across the retained profile. There were 7,526 rejected `startup_claim` calls reporting an already unresolved claim. The immediately following assistant responses alone processed 2,121,526,690 tokens. The leading PR4556 QA session processed 3,038,558,777 tokens across 6,859 requests and repeatedly reported the same reconciliation fence. These are concrete control-loop costs, not evidence of technical progress.

After the manager's 7.0.11 refresh, the 10:32:29-10:37:29 AM MDT observation window processed 13,413,916 tokens. Manager and PA accounted for 10,295,453 (76.8%); the remaining 3,118,463 were in the PR4560 crew. The PA's large uncached input also dominates its recorded cost: its latest successful sampled response processed 382,431 input tokens with zero cache reads.

## Cache boundary and verification

- Canonical instructions come from the already verified launch profile, independently of changing poll state.
- `before_agent_start` appends only these stable instructions to the native system prompt.
- `context` preserves every existing conversation message, including adjacent tool calls/results, then appends current live state as user-role data. It removes the duplicate canonical instruction prefix from that state.
- Live state does not accumulate in the stored conversation. Native root admission, helper authority checks and tool guards remain active.
- The regression failed before the fix when the checkpoint changed the system prompt. The full suite passes with 318 tests and 1,603 assertions; TypeScript checking passes.
- An installed OMP18.11.1 offline provider received two real native model contexts separated by a state-changing tool call. All 11 native guard checks pass, including identical system prompts, unchanged conversation prefixes, trailing live-state updates and the negative authority control. No paid provider call was made by this proof.

OpenRouter documents that its default conversation affinity hashes the first system/developer message and first non-system message. Keeping those stable supports both prefix reuse and provider affinity: [OpenRouter prompt caching](https://openrouter.ai/docs/guides/best-practices/prompt-caching).

At the 7.0.12 deployment, post-deployment cache-hit rates remained unmeasured while the provider key was budget-blocked. Existing blocked crew handoffs, stale completed crews and periodic supervisor inference are separate productivity/cost issues; this patch does not claim to resolve them all.


## Aspen deployment

Release 7.0.12 was fully installed through Ansible, verifying all 145 skill links and the ownership-checked companion while preserving profile configuration. All 59 native clients resumed in their original panes/transcripts/generations/launch identities. Coordinator PID3847511 and owner epoch9 were retained.

The preservation check confirms all 68 employee records, 20 crew records, 1,900 original claim IDs, 16,597 original message IDs/payloads and 1,864 original result values remain. Queue bytes and crew/runtime identities match the pre-upgrade snapshot. Both existing active claims remain recorded. No continuation prompt was issued by the refresh controller. Final health returned HTTP200, with 59/59 fresh authenticated polls; this is control-channel evidence, not a provider-cache or productivity claim.

Machine-readable test/native/deployment evidence: [cache acceptance](cache-acceptance.json).

## Cost control after 7.0.12

Version 7.0.13 removes the bridge's 30-second re-notification timer for unchanged durable messages. A pending message gets one aggregate wake; newly arriving messages coalesce behind an already scheduled wake. New messages remain eligible after that turn starts. Polling continues independently of inference.

A native provider error pauses automatic inference, including inbox cues, connection-restored wakes and stop-hook continuations. The pause is restored from the transcript on reattachment; an aborted gated turn does not erase the preceding provider failure. Correct the provider problem and submit interactive/RPC input in the same pane to resume. New machine-generated cues cannot clear the pause. Claims, receipts, crews and queue contents are retained.

Repeated identical command rejections with HTTP400/403/409 are suppressed locally and abort the native turn. This includes the unresolved-claim loop seen in the token audit. Corrected command arguments may proceed; changed canonical claim state or a fresh authenticated connection invalidates the rejected-command cache. Capacity admission/release and transport/service failures are excluded from this cache. These controls supplement the existing settlement guard.

The regression sent 61 wakes for one unchanged inbox over a simulated hour before the fix and one afterward. A real installed OMP with an offline provider made one simulated failing request, then made no additional provider calls across 100 new inbox states and a queued synthetic retry. This demonstrates request suppression, not a measured reduction in provider billing or a live cache-hit percentage. No paid inference, budget changes or credential changes were used for verification.

Test and deployment evidence: [cost-control acceptance](cost-control-acceptance.json).

Aspen's Ansible upgrade verified 145 skill links and refreshed all 59 native clients in their original panes/transcripts/generations/launches. Coordinator PID3847511 and epoch9 were retained. All 68 employee records, 20 crews, 1,900 original claim IDs, 16,755 original message IDs/payloads, 1,864 immutable result values and exact queue bytes were preserved. Both active claims remain recorded.

Across 201.534 seconds and five live samples, all 59 authenticated roots stayed fresh, health returned HTTP200, and there were zero new native model requests, recorded tokens, recorded cost or inbox wakes. Manager and PA poll ages stayed at or below 750ms and 716ms respectively. Both have restored their provider-error pause; this proves connected control clients with inference stopped, not settled PA duties or technical progress. Adding provider budget alone does not clear this pause. No budget or credential was changed by the deployment.


## Funded resume and repeated PA duties (7.0.14)

The user's funded resume began at 17:35:04 UTC on 2026-10-16. Version 7.0.14 fixes a queued-wake latch: native OMP can start through its context hook without before_agent_start, leaving the old latch set and preventing the next PA duty. The regression fails on the second duty before the fix and verifies five successive context-only duties afterward. All 327 tests (1,663 assertions), TypeScript checking and 12 installed OMP offline guard checks pass.

All 59 roots loaded 7.0.14 through Ansible, retaining native panes, transcripts, generations and launch IDs. Busy workers were deferred until idle. Coordinator PID3847511 and epoch9 remain unchanged; coordinator/store code remains identical to 7.0.9. The preservation check retained 68 employees, 20 crews, 1,933 claims, 16,879 original messages/payloads and 1,897 immutable results. Queue phases legitimately advanced during funded work.

Comparable five-minute native-usage windows:

| Role | Requests before / after | Cache reuse before / after | Recorded cost/min before / after |
| --- | ---: | ---: | ---: |
| Manager | 20 / 21 | 10.24% / 98.04% | $0.08483 / $0.00613 |
| PA | 15 / 14 | 17.98% / 99.80% | $0.09212 / $0.00275 |
| Combined | 35 / 35 | - | $0.17695 / $0.00887 |

Cache reuse is cacheRead/(input+cacheRead+cacheWrite), weighted by tokens. Supervisor recorded cost per minute decreased 94.99% with the same request count. This is native cost metadata, not a reconciled bill. Separately, the read-only OpenRouter key counter verified the user's $150 weekly limit and increased $0.188884608 across 5.99455 minutes ($0.03151/min), leaving $38.227596012. The key-wide counter and native windows have different scopes and timing.

Four early upstream HTTP404 errors paused inference. Each affected root received one explicit authorized recovery; no further provider errors appeared in the following 16-minute sample. Identical-rejection and provider-pause guards remain active. Some corrected argument and no-active-claim errors occurred, so this is not a claim of error-free execution.

After the PA refresh, at least seven consecutive new scheduled checks settled about 60 seconds apart. Each produced one compact report TO manager, without additional reminder sends. The live follow-up counted 23 PA settlements since funded resume, including finite catch-up work. All 59 authenticated polls were fresh; manager/PA ages were 174ms/733ms at the preservation check. Lifecycle alerts remained at 32 pending; the manager's older administrative backlog remains.

Real work advanced: PR4556 moved EXECUTING -> REVIEW -> QA APPROVE -> READY_TO_LAND revision8 at verified head 5d14585f462c9fd739e06bc8c630d6b6156e64ca, retaining its R4 proof deck. PR4537 moved through scoped REDO to EXECUTING revision18 and produced concrete build findings at head3011521a, including missing build-output validation and an unresolved workspace dependency. Its code rework remains pending. No new Warlock commit or merge is asserted by this proof.

Missing repositories are now explicit setup work in the intake [repository acquisition procedure](../../skills/startup-intake/references/queue-records.md#repository-acquisition). Crews resolve authoritative remotes, clone into their configured workspace, preserve existing checkouts and report actual access/identity blockers once. Missing package outputs first require manifest/setup inspection.

Machine-readable evidence: [funded resume acceptance](funded-resume-acceptance.json).


## PR4537 executable handoff recovery (7.0.15)

The old assignment receipt retained its file-bounded implementation directive only in audit evidence. Its delivered cue kept the original review-only intake, and dev settlement with an empty outgoing list left the architect without a result report. Version7.0.15 delivers the current directive verbatim with the architect destination, atomically reports all dev item outcomes, and retains an indexed review continuation with the saved result ID/current revision. QA and landing remain explicit.

The regression suite failed on both dropped string/object scopes, all three missing outcome reports and the absent continuation before the fixes. All333 tests/1686 assertions, TypeScript checking and12 installed-OMP offline guards pass. Live SQLite query plans use the own-execution, own-claim and result-claim indexes rather than loading global histories.

Aspen received the full7.0.15 upgrade (145links and owned companion). Coordinator2729361/epoch10 replaced3847511/epoch9, preserving all59 native processes and their pane/transcript/generation/launch identities. The cutover snapshot retains68 employees,20crews,2028claims,17097original message payloads and1993immutable results. One historical PR4564 QA claim remains recorded under explicit reconciliation after the restart.

The existing PR4537 crew received its two-file implementation directive verbatim at revision24. Its original dev proved empty-summary acceptance before editing (exit0), implemented the zero-task rejection (exit1 afterward), added the scan-service build script, and pushed commit2e9c65778eb428176e5dac22218eefe21eb8b076 to the original PR branch. Exactly two files changed, with five insertions; the worktree is clean. GitHub independently confirms the new PR head.

Dev completed result `pr-4537-01-impl-r23` with `outgoing: []`. The store automatically saved report sequence17123 to the owning architect, who acknowledged it. The dev submitted review revision25; the architect assigned original independent QA at revision26. This proves code production and the architect handoff. The dependency-less dev worktree did not establish a full scan-service build, and independent QA/changed-head CI remain pending.

Live preservation, exact directive/result receipts, diff, native before/after exit codes and PA/usage observations: [PR4537 handoff acceptance](pr4537-handoff-acceptance.json).
