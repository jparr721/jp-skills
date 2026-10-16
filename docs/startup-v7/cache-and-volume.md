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

Actual post-deployment cache-hit rates remain unmeasured while the provider key is budget-blocked. Existing blocked crew handoffs, stale completed crews and periodic supervisor inference are separate productivity/cost issues; this patch does not claim to resolve them all.


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
