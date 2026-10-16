# Startup V7 design

## Problem

Startup must create complete hierarchical crews, remain observable when inference stalls, and keep a mandatory manager PA supervised. V6 ties runtime ownership and employee activation to one OMP native task registry; Herdr standalone roots need independent admission. Preserve the existing audited store, immutable event-team membership, scoped results, source binding and journaled projections.

## Usage (caller's view)

Boot the canonical manager in Herdr through `/startup new NAME` or `/startup select NAME`. The extension starts a detached coordinator with an owner-only socket and log. Manager tool `startup_delegate {eventId,developers}` reserves the complete crew, starts architect/QA/dev OMP roots in the crew's Herdr tab and reports partial admission honestly. Employee `startup_claim` and `startup_settle` use an authenticated extension channel. Human interaction remains in each OMP pane; the coordinator injects pending-inbox notifications through the extension, without typing into the user's composer.

```ts
const runtime = openCoordinator({ store, herdr, config, now });
const { connection } = await runtime.admit({ credential, nativeSession, paneId, source });
await runtime.command(connection, { kind: 'delegate', eventId, developers });
await runtime.tick();
```

These are internal runtime calls; role tools hide connection credentials. Request arguments never select actor identity or role. Current native source/session and server-issued generation determine authority.

## Shape

- Coordinator is the exclusive store writer and lease owner, independent of manager inference and OMP process lifetime. The OMP extension is a client. Herdr connector owns CLI JSON parsing, pane creation and process startup; it makes no workflow decisions.
- Existing Team is the crew: manager -> event architect -> dev/QA. Membership is immutable per event. PA and shared DevOps report directly to manager. No new reusable-crew entity is needed. One crew tab groups independent employee panes; hierarchy comes from store membership, never labels, native root parent IDs or IRC recipients.
- A fully finished crew with the exact requested developer count can reuse its existing panes after observation proves idle state, resolved work/mail/claims/grants and no active turns. Reassignment creates fresh fenced generations and a new immutable Team. Partial staff pooling is outside this implementation.
- Runtime records in the same audited SQLite boundary bind launch intent, per-generation credentials, native session identity and pane/terminal locators. Intent is committed before external writes. Ambiguous launches remain uncertain until matching runtime evidence resolves them; no blind replacement.
- Root sessions use complete canonical role/loop context. Manager and PA are standing sessions. Technical crew contexts are generation-specific. Ordinary OMP helper tasks retain native execution and receive no employee admission or merge authority. A static helper guard loads in every extension factory, including helpers with no client attachment. Native abort and tool preflight denial enforce failed root admission; throwing a hook exception alone is insufficient because OMP can swallow it.
- Idle/done/blocked/unknown lifecycle snapshots normalize into timestamped durable manager alerts. Working remains queryable without waking the manager. Herdr sequences are server-wide, so forward leaps do not imply lost employee events; sequence regressions remain explicit gaps. Idle/done are observations only. A cursor and matching session identity deduplicate observations. Gaps, unknown and offline remain explicit; polling cannot promise unseen intermediate transitions.
- Authenticated extension polling is read-only notification delivery. Native `sendMessage` triggers a turn for pending own inbox; native idle/pending-message hooks release root capacity after side requests and reattachment; claims and result receipts provide durable acknowledgements. Polling never marks messages complete or pastes prompts.
- Supervision has a fixed bounded cadence and one outstanding PA check. PA remains resident, receives bounded factual summaries, and must return a settled result by its deadline. Heartbeats and terminal working animation do not count as work progress. Stale assignments, unclassified input, idle workers with outstanding claims and missed manager/PA deadlines become durable manager alerts. Work requiring a decision remains explicitly blocked; the watchdog cannot manufacture approval.
- Store item transitions remain authoritative: independent QA proof -> own architect gate -> manager landing. Other architects, workers, PA, native helpers and runtime lifecycle events cannot approve. These checks govern recorded workflow progression. Shipping restrictions come from explicit user instructions; repository-level merge denial and credential isolation are not V7 requirements.

## Synthesis decision

Candidate A is the base: one independent owner, durable effects and private employee admission. Candidate B contributes its small admitted-session facade and independent lease-renewal deadline. Reject B's manager-host lifetime because it loses the PA watcher with the manager process. Reject A's additional reusable Crew model: existing event-scoped Team already expresses the requested hierarchy. Reject terminal-paste wake delivery; preserve the human composer through OMP extension messages.

## Tradeoffs accepted

- One detached coordinator process and explicit online/offline state in exchange for supervision independent of manager model turns. Its own death and host reboot require explicit recovery; automatic service restart is not implemented.
- Explicit uncertain effects and reconciliation in exchange for duplicate prevention.
- Root-level policy/capacity admission in exchange for individually interactive employee sessions.
- Durable observed transitions plus gap reporting in exchange for using the existing Herdr API rather than promising unavailable replay.
- Coordinator root-turn slots reserve capacity for manager and PA. Each OMP root retains its own helper limit; aggregate helper capacity across roots is not enforced.
- Only management scheduling waits behind external launch operations. Existing crews can claim, report and settle during another crew's launch. Layout intent is saved before pane creation; uncertain effects cannot be blindly repeated.

## Alternatives considered

- Manager-host service: fewer processes, but exposes manager process health to every employee and PA liveness.
- Native child tasks mirrored in panes: two identities and no proof that the pane controls the actual employee.
- Per-employee store writers: duplicates policy and exposes lease/storage details to each client.
- Another workflow engine: duplicates the existing durable inbox and result receipt boundary.

## Validation and migration

Test real SQLite transactions and Unix-socket request handling with deterministic Herdr boundary fixtures; prove full-crew admission, hierarchical denial, replay/conflicts, source/session mismatch, lifecycle without settlement, PA deadline failure and stale semantic progress. Native OMP fixture probes must establish source injection and next-turn message delivery. Live acceptance subsequently ran through a controller inside a newly owned Herdr session, with its genuine inherited Herdr context. No existing user session was controlled. See [acceptance](acceptance.md).

V6 migration requires quiescence, a released lease, consistent backup and explicit reconciliation of active claims/grants before handover. That migration is not implemented: V7 uses a distinct store scope and rejects V6 ownership/configured duties. Preserve legacy queue, journal, employee, source and transcript history. Never reinterpret child session evidence as standalone root admission. V6 file-duty/repair tools are not exposed by V7. No production upgrade, profile installation, publication or version change is implicit in this implementation.

The live run proved two complete crews, direct pane input observations, periodic PA reports, real 30-second/5-minute deadline alerts and manual resumes retaining the named profile, Herdr integration, generated bootstrap and original root transcripts. Automatic Herdr restore remains unverified. The separate offline native guard probe passes 8/8 with a negative control. Neither result establishes indefinite progress or automatic OS restart.

## Module map

| Module | Owns |
| --- | --- |
| `v7.ts` | Native manager registration, host configuration and package-specific OMP settings |
| `src/employee-entry.ts` | Shared typed role tools, root evidence, input retention and fail-closed employee attachment; generated workers import without native package aliases |
| `runtime-host.ts`, `src/v7-launch.ts` | Detached process intent, private configuration, lease renewal, health endpoint and tick lifetime |
| `src/employee-client.ts` | Authenticated Unix transport, epoch readmission, canonical context, native abort/preflight guards and inbox wakes |
| `src/coordinator.ts` | Actor derivation, complete crew allocation, runtime admission, PA checks and semantic-progress supervision |
| `src/herdr-runtime.ts` | Required Herdr wire capabilities, bounded CLI calls, pane layout, agent start and observation |
| `src/store.ts`, `src/runtime-contracts.ts` | Existing audited workflow/gates plus generation-bound runtime records and atomic manager observations |
| `src/inputs.ts` | Shared exact raw input, bounded previews/pages and native attachment metadata |

## Red-flag screen

One store writer and one V7 crew activation path. Wire schemas stay private to connectors; role tools expose business commands. No load/validate/save service stack. Roster and PA summary derive from canonical state. New state and effect receipts share one transaction boundary. Shared OS access is an explicit deployment limit, not a claim that bearer tokens sandbox shells.

## Implementation assessment

The chosen ownership boundary held through implementation. Two changes reduced the candidate design: no extra reusable Crew entity and no second supervisor process. Native testing changed the enforcement mechanism from hook exceptions to abort plus preflight guards, without changing authority ownership. Outstanding deployment gates are documented above; they must not be inferred from passing fixture tests.
