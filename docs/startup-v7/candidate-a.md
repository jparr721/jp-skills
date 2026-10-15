# Candidate A: a single durable coordinator and authenticated pane employees

Historical candidate, superseded by [design](design.md). Its repository-level merge isolation proposal was dropped after the user's shipping-policy clarification; it is not an acceptance gate.

## Phase checklist

- [x] Ground: Phase A artifact, real store/adapter/profile paths, installed Herdr/OMP help and OMP integration.
- [x] Sketch: independent candidate, caller-first contract and red-flag screen.
- [ ] Agree: parent synthesis owns selection.
- [ ] Implement: deliberately out of scope for this candidate.
- [ ] Scrap: evaluate implementation deviations after selection.

## Problem

- Make a Startup survive the disappearance of its manager's native OMP task registry. Preserve existing result receipts, generation fencing, queue/resource journals and dev/QA -> owning architect -> manager authority. Every employee must run a visible, directly interactive standalone OMP root in Herdr. Current `createAdapter` combines store ownership, native task activation, lifecycle interpretation and timer execution; another root cannot discover that module-local adapter.
- The existing adapter's rationale remains a constraint: native tasks supplied parent budgets, inherited policy, transcripts and isolation. Standalone roots retain OMP transcripts but do not automatically inherit those other controls. V7 must own admission/capacity and explicitly configure each root's policy; it cannot claim equivalent runtime sandboxing.

## Usage (caller's view)

The following CLI and client APIs are proposed, not installed commands. A human starts the supervisor in a dedicated Herdr-managed coordinator pane. The supervisor validates its actual Herdr context and launches one coordinator child for this named Startup. It restarts crashed children with bounded backoff, visible diagnostics and lease fencing; it does not launch a replacement employee after uncertain delivery.

```sh
startup coordinator supervise --name acme --root /repos/acme
```

An employee extension is loaded explicitly into each independently launched OMP root. The extension authenticates from a private launch manifest before registering role-bound tools. Its native OMP context supplies session identity, not a model-selected employee ID.

```ts
const employee = await connectEmployee({
  launchManifestPath,
  session: readPersistentSession(ctx),
});

if (employee.role === "manager") {
  await employee.command({
    kind: "assign-crew", requestId, eventId, crewId, assignment,
  });
}
```

Dev/QA results still use the existing atomic settlement plus outgoing-message contract. The caller supplies a saved claim and result, not an actor or a recipient capability.

```ts
await employee.command({ kind: "settle", requestId, claimId, result });
```

The owning architect gates only the reviewed item and recorded revision; the manager alone records final landing/completion under the existing workflow.

```ts
if (employee.role === "architect") {
  await employee.command({ kind: "item", request });
}
// request is the existing ItemAction schema narrowed to this role.
// The coordinator checks actual crew/event ownership and QA result linkage.
```

The human can type in any employee pane, inspect OMP history and answer native dialogs. Direct interaction does not turn an employee into a manager or create durable intake implicitly. A worker needing broader authority reports through its architect; a new user work event still enters through the canonical manager. Native OMP input provenance is not proof of human identity because terminal automation can also enter text.

## Shape

| Module | Knowledge owned | Public surface |
| --- | --- | --- |
| `src/coordinator.ts` | Authentication, command authorization, durable command receipts, sole store lease, supervision policy and durable effect scheduling | Proposed `serveCoordinator(config, runtime)`; private request parser |
| `src/store.ts` | Existing serialized records, transitions and projection journals; new crew, runtime binding, supervision and effect records in the same SQLite transaction boundary | Existing domain operations plus transactionally integrated V7 operations; reachable only inside coordinator package entry |
| `src/herdr-runtime.ts` | Exact Herdr CLI/socket schema, server identity, launch/readiness reconciliation, lifecycle cursor and bounded polling | `launch`, `observe`, `deliverWake`; no workflow decisions |
| `index.ts` and `src/client.ts` | Native extension events, canonical full role/loop context, authenticated local connection, tool projection | Proposed `connectEmployee` returning a role-discriminated client |

- One coordinator exclusively opens `staff.sqlite`; employees never open it or write canonical `queue.json`/`resources.json`. Preserve the existing journaled projection and changed-outside-runtime rejection. External file edits require explicit reconciliation. Coordinator commands, command receipt and outgoing effects commit atomically; side effects occur afterward.
- Keep one named Startup's existing state directory and database. Version the schema in the same database; add record kinds to the existing audited record mechanism instead of introducing another workflow database. The standalone coordinator epoch is distinct from employee generation and manager generation. A coordinator restart fences connections and active claims without inventing a new manager.
- Add durable `Crew { id, managerId, architectId, qaId, devIds, state }`. One active crew owns each crew employee; the manager may supervise many crews. Crew membership persists across events and pane restarts. Existing `Team` becomes an immutable event allocation referencing `crewId`, with its existing generation snapshot and readiness gates. One crew runs at most one active event allocation initially. Reuse after resolution re-admits that same crew's roots with new assignment context/generations; no silent reassignment of a different architect. Existing teams remain historical facts.
- Add `RuntimeBinding` keyed by employee generation. It records launch intent, expected Herdr server, immutable native session identity, current pane locator, canonical source hashes and admission state. Pane location and live alias are mutable locators, never employee identity. Human pane moves are reconciled by native session evidence; a mismatch blocks delivery until resolved.
- A launch begins with a committed intent and a generated private bootstrap extension/manifest, then `herdr agent start NAME --kind omp --pane ID -- --cwd ROOT --extension BOOTSTRAP`. OMP profile/session policy is explicit per role; canonical role/loop text is projected by the bootstrap at the same boundaries V6 uses. Confirm live OMP version, loaded extension and canonical source hashes before admitting any claim. Preserve native task for ordinary bounded helper tasks; those helpers are never admitted as Startup employees.
- Herdr creates layout first; use returned IDs and `--no-focus`. The crew's architect/dev/QA panes are grouped in a crew workspace/tab with names derived from persisted launch IDs within Herdr's naming constraints. PA and manager are separate standing panes. No layout or pane control was run during this design.
- A generic bootstrap file contains only a launch-manifest locator, not an inline token. Generate an unguessable per-launch credential, store only its digest plus scope in SQLite, and keep its plaintext in the private manifest. Authenticate over a private Unix socket; on every connection check credential, Startup, employee generation, coordinator epoch, native session evidence and current admission. Rotate on employee replacement; reconnect requires fresh epoch admission. An extension cannot choose its role or employee ID in model tool parameters. Path permissions reduce accidental disclosure but do not isolate agents sharing one OS account.
- The client surface hides wire framing, retries, source binding, authorization and receipt lookup. It exposes role-limited domain commands and snapshots because a single generic transport method would leak authentication and actor selection to every tool. All external bytes parse as `unknown` into strict schemas; all role and ownership checks execute again in the coordinator regardless of client types.

### Durable access patterns

| Operation | Durable key / constraint | Transaction and effect |
| --- | --- | --- |
| Command retry | `(employeeId, generation, requestId)` plus request digest | Exact replay returns saved receipt; changed payload rejects. Terminal-input effects are never repeated solely because response timed out. |
| Admit event | `eventId -> existing Team`, `crewId -> active allocation` | Validate full crew, reserve Team and generation contexts, append launch/admission effects; expose no claims until all required roots bind. |
| Claim/settle | Existing employee-scoped inbox, generation/epoch claim | Preserve `settleClaim`: result, outgoing cues, claim status, checkpoint and assignment status commit together. |
| Herdr observation | `(serverInstance, employeeGeneration, nativeSession, stateChangeSeq)` when verified available | Deduplicate and append manager inbox cue atomically with observation/cursor. Initial attach is a snapshot, not completion. |
| Supervision wake | `(subject, dutyKind, dueOccurrence)` | Persist one due occurrence and its manager/PA cue before wake; receipt prevents duplicate work acceptance. |
| Gate/merge progression | Item ID, expected revision, owning Team and saved QA/dev result IDs | Keep `transitionItem` ownership checks; no Herdr event can call a gate or completion action. |

- Use SQLite uniqueness/transactions for the new direct keys; do not add an in-memory authoritative registry or a second hand-maintained roster. Existing store scans can remain for existing bounded data. Queryable indexes and uniqueness on crew allocation, credential digest and effect dedupe keys belong in the schema migration, not an unspecified future cache.
- Lifecycle ingestion uses bounded observation through the installed API and stable cursor when supported. Herdr idle/done changes produce durable `runtime-observation` cues directly to manager, bypassing employee report hierarchy only as system facts. They never settle claims, approve work or advance items. A state change missed during observer downtime cannot be reconstructed from a current-state snapshot; emit an explicit observation-gap cue and retain all received evidence.
- Verify the installed response fields before depending on `state_change_seq` / `completion_seq`; pin the minimum supported capability. Without a verified monotonic identity, activation is blocked with a dependency error rather than guessing event identity. Polling can miss intermediate states even with a monotonic sequence; the API must prove replay to promise every transition. V7 promises durable delivery of every observation it receives and explicit gaps, not unsupported exact event replay.
- The extension maintains a separate authenticated control connection receiving only `inbox pending` notifications. It uses the native extension message mechanism to trigger a turn without terminal paste, then claims durable message IDs normally. Herdr still launches and observes panes. This keeps the human composer available and avoids lifecycle-based `agent prompt --wait` being mistaken for per-job acknowledgment. A wake can repeat; domain settlement cannot. An unverified reconnect/message-injection API is an implementation gate, not a reason to silently revert to native tasks.

### Supervision and recovery

- A coordinator timer owns progress deadlines. `lastTransportSeen` means connection health; `lastProgressAt` advances only on semantic progress such as a result, transition or explicit blocker/update. Working animation, repeated heartbeats and timer wakeups do not reset progress. Persist cadence, deadline, last occurrence, acknowledgment and escalation state.
- PA is one mandatory standing employee while Startup runs, permanently assigned to manager. Its duty receives factual, bounded snapshots of pending inbox, stale items, explicit blockers, unacknowledged manager alerts and coordinator observations. PA may report or ask; it cannot gate, merge, repair resources or accept work. It is resident and periodically woken, with one outstanding occurrence at a time. A waiting PA is healthy if connected and its due occurrence/deadline is satisfied.
- A missed PA deadline, disconnected PA, or absent manager yields a durable degraded-health record and manager cue; notify the still-connected counterpart. The coordinator independently emits stale-progress facts even if PA fails. If manager is offline, queue alerts and show degraded health in PA/coordinator panes. Do not let PA impersonate or automatically replace the manager. A disconnected employee session may reconnect to the same identity; replacement requires explicit reconciliation and a generation change.
- The supervisor sees coordinator child exit and restarts it with bounded backoff. Supervisor death or complete Herdr outage cannot be monitored by that child; status is offline and cold resume is required. This candidate does not claim a same-process timer detects its own death. Host reboot auto-start is a separate, unproven operational dependency, outside the minimal V7 runtime.
- Cold startup: acquire the sole lease, recover existing file journals, move active claims/grants to reconciliation as V6 already does, expire previous epoch connections, inspect launch effects and current Herdr session identities, reconnect matching roots, then drain inbox notifications and due supervision occurrences. Do not re-run assignments or replay uncertain terminal launch/prompt effects. Inspect before adopting; if no reliable identity matches, record the exact blocker and require an authorized manager recovery decision. Employee credentials may reconnect to the same generation only after fresh session/epoch admission.
- Keep launch effect states `prepared`, `submitted`, `confirmed`, `uncertain`. A process exit after submission but before confirmation cannot imply failure. Reconcile against saved pane plus OMP session evidence; never start another root while the first may be alive. Existing manager recovery errors, grants, claims and checkpoints remain queryable.

### Authority and credential limits

- Preserve current workflow semantics: QA APPROVE records proof; only the owning architect may gate to READY_TO_LAND after saved QA proof; manager alone records MERGED/DONE. Both manager and owning architect may make their existing scoped decisions. Another crew's architect, dev, QA, PA, lifecycle observer and watchdog cannot approve progression. Binding checks are enforced in the coordinator and existing store, not merely role prompts.
- This enforces Startup state, not arbitrary host actions. Same-account workers with shell access can read manifests/database or invoke an already authenticated `gh`. Private Unix sockets and bearer tokens cannot prevent deliberate impersonation by that account. Disabling one native tool or hiding a token from model context does not prove credential isolation.
- Hard external merge prevention requires a separate protected credential broker/OS identity and repository rules that deny employees direct merge credentials. Under such a deployment, the broker must require a coordinator receipt pinned to repository, PR head SHA, item revision, approving manager/own architect and saved proof, and must verify head SHA immediately before the merge. Neither broker nor repository configuration is currently proven. Until that deployment contract exists, report `external_merge_enforcement: unverified`; never claim only manager/architect can merge at GitHub.

### Migration from V6

1. Quiesce V6 on its existing root; persist explicit migration intent, stop new admissions, settle known results and retain uncertain claims/grants. Wait for the current native adapter to release its lease. Never run two writers.
2. Back up SQLite consistently and preserve queue/resource journals, source hashes, native transcripts and immutable events. In a transaction, version the store metadata and retain V6 scope/provenance. Retain the original `scope.managerSession` and manager native identity when resuming the canonical root; coordinator restarts do not require changing that scope. Any future replacement with a different manager transcript requires an explicit audited migration, not a silent schema rewrite. Do not edit old audit entries or erase `managerSession` provenance.
3. Form one durable crew per unambiguously identified current/historical membership set with an authorized migration mapping. Do not guess when staff have incompatible memberships or unresolved work. Historical Teams get provenance; only explicitly adopted active allocation links to a crew. Existing hired staff not mapped to a crew remain pending reconciliation. Adopt a pre-existing PA only after valid source/session binding; otherwise prepare the mandatory standing PA.
4. Record prior native bindings as legacy, fence their future mutations, reconcile active work and launch independent OMP roots through Herdr. Resume the original manager root session in its Herdr pane where verified; V6 child transcripts remain history. Make no unsupported claim that `omp --resume` turns a native task child into a fully equivalent root. Carry canonical source, saved checkpoint, assignments and inbox, with an explicit migration receipt; archive rather than discard old references.
5. Switch the installed Startup extension to the remote client only, remove module-local root adapter ownership and native Startup hire/wake/task interception in the same release. Do not keep a compatibility write path that can reopen V6 after migration. Ordinary OMP tasks retain their native behavior. Rollback requires quiescing V7 and restoring the backed-up V6 state; it cannot apply V6 code to an advanced V7 store.

## Synthesis decision

- Pending parent comparison. Candidate A recommends one standalone, supervised coordinator with an authenticated extension notification channel, durable crews layered above existing event Teams and Herdr as process/layout/lifecycle authority.

## Tradeoffs accepted

- We accept one coordinator's availability and a dedicated visible coordinator pane in exchange for a single state owner and independent employee roots.
- We accept one active event per durable crew initially in exchange for reuse of V6 event/claim invariants and simple exclusive crew assignment.
- We accept explicit reconciliation after ambiguous external effects in exchange for avoiding duplicate roots and duplicated work.
- We accept changed standalone policy/capacity configuration in exchange for direct human interaction with each native OMP root.
- We accept an honest observation-gap status in exchange for avoiding an invented Herdr replay guarantee.
- We accept operational identity checks rather than a same-user security claim; hard external merge enforcement remains blocked on deployment isolation.

## Alternatives considered

- Manager-root extension with native task children: hides native launch details, but exposes process registry/lifecycle recovery obligations to every cross-root caller and fails standalone visible employee ownership.
- Each employee opens SQLite and coordinates by lease: shorter local calls but exposes storage fencing and workflow invariants to every extension. Multiple process writers widen authority and make policy drift likely.
- Coordinator plus a second workflow engine/message broker: hides generic retry machinery, but makes callers reconcile V6 receipts, broker jobs and pane lifecycle across three authorities. Existing durable inbox/outbox can own those decisions.
- Herdr terminal prompt delivery for every wake: removes a control connection, but exposes composer collisions, lifecycle ambiguity and per-job acknowledgment to callers. Authenticated extension notifications hide that complexity and preserve direct human pane use.

## Red-flag screen

| Flag | Result |
| --- | --- |
| Shallow module / long chain | Client -> coordinator -> store is the workflow path; coordinator owns auth, receipt and supervision decisions. Herdr runtime is the external connector. |
| Information leakage | Herdr JSON, wire auth, SQLite schema and native registries do not appear in role tool arguments. |
| Split ownership | Only coordinator owns Startup business state; Herdr owns process/layout state; OMP owns transcript/execution. Observations are evidence, not a shadow workflow. |
| Two ways to do one task | Migration deletes the native Startup execution path. No prompt-only or alternate store writer. |
| Importable internals | Proposed package exports client contract only; build boundary check rejects external store/coordinator imports. Runtime shell access remains the stated deployment limit. |
| Hand-synced lists | Existing canonical role schema and item-action schema derive role projections; server authorization remains authoritative. |
| Temporal decomposition | No separate validate/load/save services. Domain operations persist complete receipts and effects in one transaction. |

## Open questions and risks

- Does the installed Herdr API expose stable server-instance identity, state sequence and a replay cursor; if not, is durable observed-state delivery plus explicit gaps sufficient for the product requirement?
- Can the standalone extension's authenticated connection reliably trigger native next-turn delivery across suspend/reconnect without disrupting interactive input? Prove this with the installed OMP API before broad implementation.
- What deployment identity/credential broker and repository rules will make the requested external merge restriction enforceable against worker shell access?
- Is manual cold resume after supervisor/Herdr loss sufficient, or must a host service outside the Herdr session provide restart and health reporting? That adds an explicit operational dependency.
- Which V6 employees/teams are authorized for adoption when historical membership is ambiguous?

## Next implementation step

- Write failing real SQLite/coordinator tests proving generation/epoch fencing and role/owning-architect denial, then an isolated Herdr feasibility probe for standalone handshake, visible direct input and durable idle/done notification before migrating any live state.

## Grounding evidence

- Phase A: `/Users/jarredparr/.codex/worktrees/startup-v7/jp-skills/docs/startup-v7/grounding.md`.
- Read `extensions/startup/index.ts` boot/root adapter path and tool registrations; `src/omp-adapter.ts` native activation, settlement and timer paths; `src/store.ts` lease acquisition/recovery, `reserveTeam`, `settleClaim` and `transitionItem`; `src/contracts.ts` and `src/profiles.ts` complete canonical source binding.
- Installed help read 2026-10-15: Herdr `0.9.5`, `agent start --help`; OMP `18.8.9 --help`; `/Users/jarredparr/.omp/agent/extensions/herdr-omp-agent-state.ts` integration version 10. Integration reports native session identity/lifecycle but may coalesce pending states; it is not a durable Startup event log.
- Official [agent automation](https://herdr.dev/docs/agent-automation/) confirms layout/agent separation, mutable pane locations, ephemeral aliases and lifecycle-based prompt waits. Official [integrations](https://herdr.dev/docs/integrations/) confirms OMP session/state reporting and native restore. Official [session restore](https://herdr.dev/docs/session-state/) was consulted; restore is not proof of coordinator/business receipt recovery. Installed help remains the launch syntax authority.
