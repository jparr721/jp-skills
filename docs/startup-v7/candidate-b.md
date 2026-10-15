# Candidate B: manager-host companion with managed employee roots

Historical candidate, superseded by [design](design.md). Repository-level merge isolation is not required under the user's later shipping-policy clarification.

## Problem

- Put the Startup companion inside the canonical manager's interactive OMP process. It alone opens `staff.sqlite`, schedules observation, authenticates employee requests and controls Herdr employee roots. Herdr owns panes and process visibility; every employee is an independent, directly accessible OMP root.
- Preserve the store's crew membership, inbox, settlement, lease, projection recovery and item gates. Replace the current same-process native-child identity and wake mechanism rather than pretending a Herdr root is a native task child.
- Verdict: feasible when "manager stuck" means inference waiting or an asynchronous tool waiting while its host event loop runs. Reject as the complete V7 shape if progress and PA supervision must continue when the manager host freezes or exits. That failure stops the sole supervisor and requires an independent owner to solve.

## Usage (caller's view)

- Existing manager command `/startup <name>` remains the sole boot path. Boot starts the companion as part of the manager extension; no coordinator service command exists.
- Manager delegates a persisted intake event to an entire crew. The host reserves architect, QA and dev membership, creates visible panes, starts independent OMP roots, verifies their complete canonical role and loop context, then admits the crew. Employee role and identity come from the admitted connection, never operation arguments.
- Employee tools keep the business vocabulary: claim own inbox, settle a result, record a permitted item action. An employee does not manipulate Herdr targets or native sessions. A manager's crew receipt includes pane references so the human can attach or focus directly.

```ts
// Proposed entry.ts call site inside manager initialize().
const host: ManagerHost = await openManagerHost({
  context: managerContext,
  startup: selection,
  dependencies: hostDependencies,
});
registerStartupTools(pi, host.manager);

// Proposed worker entry.ts call site after its own native session_start.
// The admission ticket is launch configuration owned by the host shell.
const employee: EmployeeSession = await attachEmployee({
  context: employeeContext,
  admission: launchAdmission,
});
registerStartupTools(pi, employee);

// Proposed host-owned observation call site. No inference turn required.
await host.supervise({ observedAt: clock.now() });
```

- Existing `startup_settle` and item tool names can remain stable. Startup employee `task` hire/delegate modes become manager tool operations backed by the host; ordinary bounded OMP task use remains ordinary OMP task use. There is exactly one production crew activation path after migration.

## Shape

### Public types and signatures

```ts
// Domain API sketch only. These are proposed APIs, not existing exports.
type CrewRequest = Readonly<{
  requestId: RequestId;
  eventId: IntakeId;
  developers: PositiveInteger;
}>;
type CrewReceipt = Readonly<{
  crewId: CrewId;
  state: "reserved" | "ready" | "reconciliation";
  employees: readonly EmployeeView[];
}>;
type EmployeeView = Readonly<{
  id: EmployeeId;
  role: "architect" | "qa" | "dev" | "devops" | "pa";
  presence: "starting" | "ready" | "offline" | "uncertain";
  pane: PaneReference | null;
}>;
type EmployeeSession = Readonly<{
  claim: () => Promise<OwnClaim | null>;
  settle: (request: OwnSettlement) => Promise<SettlementReceipt>;
  item: (request: ItemAction) => Promise<ItemTransition>;
}>;
type ManagerSession = EmployeeSession & Readonly<{
  delegate: (request: CrewRequest) => Promise<CrewReceipt>;
  staff: () => Promise<StaffView>;
  reconcile: (request: RecoveryDecision) => Promise<RecoveryReceipt>;
}>;
type SupervisionTick = Readonly<{ observedAt: Timestamp }>;
type ManagerHost = Readonly<{
  manager: ManagerSession;
  supervise: (tick: SupervisionTick) => Promise<void>;
  close: () => Promise<void>;
}>;

declare function openManagerHost(input: ManagerHostInput): Promise<ManagerHost>;
declare function attachEmployee(input: EmployeeAttachInput): Promise<EmployeeSession>;
```

- Identifier types are opaque values parsed at the boundary. Protocol request envelopes, socket paths, launch tickets, OMP registry objects and Herdr JSON do not escape into business callers. `ItemAction` remains a discriminated union from existing item policy; the server still validates authorization because the employee client interface alone is not a security boundary.
- The six operations carry business intent. Session admission, source verification, lifecycle normalization, durable observation, idempotent wake delivery and expiry policy stay behind them. Manager and employee do not coordinate launch, bind and wake calls themselves. This is a deep interface; the cost is concentrating more behavior inside the manager-host boundary.

### Data structures first

| Record | Owner and dominant access | Invariant |
| --- | --- | --- |
| Existing employee, crew, inbox, claims, items, projections | Fenced `StartupStore`, accessed by accepted session binding | One business writer; dev/QA report to own architect, architect to manager |
| Runtime root binding | Host-private durable row keyed by `(employeeId, generation)` | Binds pane, launch attempt, native root session and source hashes; label alone has no authority |
| Launch attempt | Host-private durable row keyed by `requestId` and employee generation | Persist intent before Herdr side effect; distinguish requested, ready, uncertain, rejected |
| Observation | Host-private durable row keyed by employee generation and observation sequence | Separate observed lifecycle, last business settlement and last host observation |
| Delivery attempt | Host-private durable row keyed by durable inbox cue ID and generation | Prompt submission is transport acknowledgement; settlement alone completes work |
| Supervision occurrence | Existing durable duty occurrence plus an internal fixed PA cadence | Deduplicate `(dutyId, scheduledFor)`; PA remains employed even when idle |

- Existing `Team` maps one raw intake event to one architect, one QA and one or more devs. Keep that mapping immutable. If crews become reusable across multiple intakes, add a distinct crew identity and event assignment relation; do not overload current `Team.eventId` or reassign historical team members.
- Derive roster, backlog and PA factual summaries from the store plus freshness-qualified observations. Do not maintain JSON roster files or a separate event-sourced replica. Herdr is observation input, never the canonical work queue.
- Record manager health separately from manager inbox backlog. A live process with a renewing lease does not prove useful managerial progress.

### Modules and data flow

| File boundary | Knowledge owned | Changes |
| --- | --- | --- |
| `extensions/startup/index.ts` | Native boot and tools | Select manager or launch-ticket employee mode; expose admitted facade; retain full source projection |
| Proposed `src/manager-host.ts` | Root admission, crew launch, monitoring and authenticated request handling | Sole store owner and managed timer; business requests reach `store.ts` in at most one module hop |
| Existing `src/store.ts` and `src/items.ts` | Durable workflow and authority | Preserve policy; add runtime-root records and generic source-verified session binding where required |
| Proposed `src/herdr.ts` | Herdr versioned CLI/socket representation | Own supported start/prompt/get and pane resolution; normalize to domain observations; no workflow gates |
| Existing `src/profiles.ts` | Complete role/loop content and hash verification | Reuse loading/verification; add root launch projection, stop using child-agent markdown as root admission proof |
| Existing `src/duties.ts` | Durable scheduled observations and authorized repair | Reuse occurrence/recovery semantics; remove dependence on root native tools for observations needing no model |

- Do not wrap `omp-adapter.ts` with `manager-host.ts`. Its assumptions are substantive: `rootAdapter()` traverses one process's registry, `nativeRef()` verifies child transcript `parentSession`, `activate()` uses a native task handler and `wake()` uses `agent://` write transport. Split reusable domain/store calls out or replace this adapter; keeping both crew paths would recreate split admission ownership.
- Bind each root using an opaque, single-use launch admission associated with the exact durable attempt, generation and expected canonical hashes. Worker extension supplies its actual OMP session evidence. Host checks the Herdr pane/process/native session correlation before turning the binding ready. A copied marker or model-supplied employee ID is insufficient.
- The transport is a manager-host local endpoint. Its client does not open SQLite. Use bounded requests with request IDs, explicit schema errors and generation fencing. Timeout after send is uncertain; retry the same logical request ID, never generate a new launch or settlement ID.
- Host supervision must use one serial work promise like `createDuties.tick()`. Existing lease timer's async callback is not sufficient as a new monitoring loop: a slow pass must not overlap later passes. Observation I/O needs deadlines; a hung Herdr operation must not block lease renewal or every employee observation.

### Lifecycle and direct pane access

1. Reserve complete crew and durable launch attempt.
2. Create owned Herdr pane; persist returned pane reference; start OMP root using supported `agent start NAME --kind omp --pane ID -- ARGS` with explicit root profile/extension context.
3. Treat interactive readiness as process readiness only. Require source-verified extension admission before crew readiness or inbox claims.
4. Poll supported Herdr state through the host timer. Installed help exposes `api snapshot`, `agent get/list/wait` and pane/process metadata; no custom event subscription is assumed without verifying the bundled schema. Normalize observed changes into durable manager inbox cues, including idle/done, blocked, unknown and lost identity.
5. Wake an employee using the durable inbox cue ID. Installed `agent prompt --wait` matches lifecycle, can match completion of an already running turn and is not per-job proof. Never equate it with `startup_settle`.
6. User can focus/attach/type into any employee pane. Employee input interception preserves native input evidence and forwards work/priority/approval requests as manager inbox input; conversation can stay local, but never changes crew authority. A direct user prompt does not convert the employee root into the manager.

- Herdr names can disappear or be reused after exit. Every control operation resolves the expected pane and native session generation first. If resolution is ambiguous, stop and retain the attempt as uncertain. Do not press keys into an unverified target.
- Do not blindly repeat pane creation, start or prompt after a timeout. Reconcile recorded attempt against process/session evidence. If delivery cannot be proven or disproven, require explicit decision; do not infer completion from idle.

### PA supervision and manager stuck

| Failure | Result in this candidate | Recovery |
| --- | --- | --- |
| Manager inference awaits provider or asynchronous tool, event loop live | Host timer continues durable observation, PA factual-summary delivery and missing-progress alerts | PA report enters manager inbox; host exposes overdue managerial handling; no approval impersonation |
| PA idle | Permanent root remains resident; host delivers periodic scoped summary and checks expected claim/settlement deadline | Idle is acceptable between ticks; no continuous token burn |
| PA blocked, unresponsive or exited | Host persists degraded PA supervision and informs manager; no new PA approval power | Rebind/restart only after generation and unresolved-claim reconciliation |
| Manager unresponsive as decision maker | PA can continue reminders; crew work reaches explicit dependency/approval blockers | Manager must resume or human must authorize a replacement manager; host never auto-approves |
| Manager event loop frozen or process killed | All host timers, business writes, lifecycle delivery and PA supervision stop | Herdr may still show panes, but the candidate has no independent monitor to guarantee an alert or restart |
| Herdr unreachable but manager host alive | Host heartbeat continues; observations become stale/unknown, new launches and uncertain wakes stop | Reconcile identity on connection return; no invented employee health |
| Lease expired or stolen | Further writes fail via store fence; employee requests receive explicit unavailable/fenced error | Reopen only through canonical manager recovery; reconcile claims and grants |

- A PA-local timer can report manager silence but cannot supervise itself when both it and the manager host fail. It is not a repair for the last failure row. An independent Herdr supervisor could solve that row only by implementing a new persistent actor with deadlines, restart policy and ownership fencing. That changes this candidate into another independently supervised owner, not a small extension tweak.
- Therefore "PA always active" can mean resident, periodically woken and supervised while the manager host is healthy. It cannot mean supervised across manager-host failure in this shape.

### Approval and credential limits

- Preserve exact workflow checks: QA APPROVE supplies evidence; owning architect gate moves REVIEW to READY_TO_LAND; only manager may record MERGED, DONE or REJECTED. Source-verified connection binding, current generation and expected revision are validated server-side on every mutation. Lifecycle messages never invoke item gate operations.
- Require architect evidence and manager merge authorization for the same PR head. A new head invalidates approval and QA/gate evidence. Merge execution must consume a durable manager authorization rather than treat successful GitHub output as authorization.
- These rules enforce Startup's workflow only. Every employee launched under the same OS user may read files and inherit existing GitHub credentials or use existing `gh` authentication. OMP profiles isolate OMP state; the inspected CLI does not establish shell credential isolation. A hidden local token or removed MCP merge tool cannot prove employees cannot merge out of band.
- To make "strict" mean repository-enforced prevention, repository rules and scoped identities must prevent dev/QA principals from merging, and the manager merge principal must be inaccessible to employee shell/file access. That needs a verified credential/process boundary outside this same-user proposal. Until proven, label enforcement as workflow-only and fail any stronger acceptance claim.

## Synthesis decision

- Candidate status: preserve for comparison, reject as final base under the full always-watched requirement. Use its small admitted-session facade and reuse of the existing fenced store in the selected independent-owner design.
- It is structurally distinct from a standalone coordinator: the manager native host owns lifetime, lease, scheduling, endpoint and recovery. No independently alive coordinator process exists.

## Tradeoffs accepted

- Accept manager-host process coupling in exchange for reusing native boot, root transcript evidence and managed timers without a new daemon lifecycle.
- Accept replacing native-child transport in exchange for real persistent employee panes and direct human access.
- Accept explicit uncertainty and bounded halted progression in exchange for avoiding duplicate launches and fabricated job acknowledgements.
- Accept runtime monitoring independent of inference but dependent on the manager event loop in exchange for fewer processes. This is the disqualifying tradeoff for full V7 acceptance.

## Alternatives considered

- Standalone Startup coordinator: hides recovery, role binding and process-independent monitoring behind nearly the same facade; needs a supervised service, but exposes fewer availability assumptions to the manager. Stronger interface depth for the required failure scope, so it beats this candidate.
- Herdr supervisor owns a persistent actor log: makes pane lifecycle and business supervision share one durable process. Would require a supported Herdr extension hook or upstream Herdr implementation that has not been established in this repository. Replacing `StartupStore` with a second event log exposes migration, authority and projection replay complexity; importing the store preserves depth but still needs Herdr server product changes. Reject as an unverified external extension dependency.
- Keep native task children and mirror panes: avoids replacing identity validation but exposes two independent runtime identities and does not establish direct interactive access to the actual employee root. Reject.

## Open questions and risks

- Does always-watched explicitly permit supervision stopping when the manager process exits? If not, this candidate is disqualified without a trial implementation.
- Can the chosen deployment provide separate GitHub merge credentials and repository rules that employees cannot access through their OS user? If not, strict merge prevention cannot be claimed.
- Will crews persist across intake events? If yes, separate crew membership from the current per-event team relation before exposing reusable crew APIs.

## Next implementation step

- In the selected design, first add tests demonstrating that independent OMP roots cannot forge employee/manager bindings, then implement the admitted-session facade against existing `StartupStore`; do not implement this manager-host lifetime unless its failure scope is explicitly accepted.

## Migration and proof gates

1. Preserve V6 SQLite, canonical queue and journal history. Add schema/versioned runtime-root records; do not rewrite old child bindings as root evidence.
2. Quiesce old owner; reconcile active claims, held grants and pending journals; require lease handover before a new owner opens the store. Historical native handles remain audit evidence.
3. Replace crew activation and wake as one coherent path. Remove native-child Startup dispatch admission when root mode is enabled; never let worker root extensions auto-select manager mode from cwd alone.
4. Test complete crew admission, stale/copied launch tickets, wrong pane/session, source drift, request replay, simultaneous owner attempts, timeout before/after actual start, lifecycle idle without settlement, direct-pane user requests, stale PR head, PA missed deadlines, manager inference stalled and manager process death.
5. Fault test process death explicitly. Expected result for this candidate is loss of supervision, not success. Reject the design if that violates acceptance.

## Source evidence read for this package

- `extensions/startup/index.ts`: `HostAPI`, `rootAdapter`, `initialize`, `session_start`, task wrapper and manager `sendMessage` wake.
- `extensions/startup/src/omp-adapter.ts`: `NativeContext`, `createAdapter`, lease timer, `nativeRef`, `boundCaller`, `wake`, activation, duties wiring and shutdown.
- `extensions/startup/src/store.ts`: `openStore`, lease fence, `reserveTeam`, `transitionItem`, architect gate and manager completion checks.
- `extensions/startup/src/contracts.ts`: source, binding, employee and event-team representation.
- `extensions/startup/src/profiles.ts`: complete role/loop loading, hashes, child markdown and projection.
- `extensions/startup/src/duties.ts`: host methods, serialized tick, occurrence scheduler and shutdown.
- `skills/startup-role-pa/SKILL.md`: scoped manager-supplied facts, no PA polling, host-offline limitation.
- Phase A `docs/startup-v7/grounding.md` in the parent worktree.
- Installed read-only `herdr agent start/prompt`, `agent`, `pane` and `api` help; installed `omp --help`, 2026-10-15. No live panes controlled or new processes started for this design.

## Red-flag screen

| Flag | Result |
| --- | --- |
| Shallow module | Pass: session facade hides binding, durable requests and process transport; no public launch pipeline |
| Information leakage | Pass: Herdr/native wire records are private; business clients use domain values |
| Temporal decomposition | Pass: host owns admission and recovery policy end-to-end; no load/validate/save service chain |
| Pass-through methods | Pass if `omp-adapter` is replaced/split; wrapping its exported methods would fail |
| Split ownership | Pass: one host opens SQLite; Herdr only owns process state; no independent workflow replica |
| Two ways to do one task | Pass only with atomic migration away from child crew activation |
| Importable internals | Implementation gate: package export/lint boundary must prevent workers importing the host-only store connector |
| Hand-synced list | Pass: roster and PA summary derive from admitted employees and current observations |
| Failure ownership | Fail full requirement: sole supervisor dies with manager host; PA has no independent watcher |
