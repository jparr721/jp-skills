# V7 grounding

## Phase checklist

- [x] Ground: trace V6 and installed Herdr/OMP contracts.
- [x] Sketch: two isolated candidate packages, red-flag screen and synthesis.
- [x] Agree: architect default is no checkpoint; incorporate user corrections continuously.
- [x] Implement: test first, implement chosen shape, verify candidate with local and native guards.
- [x] Scrap: evaluate deviations; retain single coordinator, remove extra Crew/supervisor layers and use proven native guards.

## User requirements

OMP, Herdr and Startup companion are mandatory. Each employee has a visible, directly interactive pane. A durable crew has an architect, QA and one or more devs, under one manager. The PA is permanently assigned and supervised while Startup runs. Herdr idle/done changes are durable messages to manager, never work acceptance. Architect/manager permissions govern canonical review/completion records. The user later removed strict merge control: an agent shipping is acceptable, shipping restrictions must be explicit, and repository credential isolation is not required. Progress must be monitored, with explicit blockers and recovery rather than silent staleness. Screenshot on 2026-10-15 shows individual OMP task agents and a flat roster, not evidence of runtime crew admission.

## Current trace and rationale

`extensions/startup/index.ts` registers native `/startup`, boot/input/context/tool/stop hooks and same-name `task`. Boot selects a named binding, refreshes root AGENTS and constructs `createAdapter`. A module-local map ties descendants of one native root registry to one adapter. The adapter opens `staff.sqlite` with lease, owns timers and uses native task handler for hire/activation. Native children are generated `.omp/agents` profiles; registry and provider-context evidence bind canonical complete role/loop hashes. This shape deliberately preserves OMP parent policy, budget, transcripts and task isolation. It also makes persistent employee activation depend on a current task handler and same-process registry.

`store.ts` is already the serialized state owner: lease fencing, stable hire IDs, immutable event-team memberships, source binding, scoped inbox/claims, atomic result/outgoing settlement, journaled queue/resource file projection and recovery. `reserveTeam` admits whole crew membership but readiness depends on all native bindings. Reports are enforced dev/QA -> own architect -> manager, standing staff -> manager. `transitionItem` enforces dev review, independent QA proof, own architect gate and manager completion. QA APPROVE is proof, not merge authorization. Preserve these invariants and history, do not substitute terminal state for result receipts.

`profiles.ts` reads complete canonical role and loop sources, hashes and verifies them before admission and context projection. Native OMP profiles are children today; V7 standalone root sessions need a different identity transport and authenticated coordinator access. A model must not select its employee ID or role in operation parameters. All workers currently share the OS user and potentially shell credentials: runtime role checks alone do not prove repository-enforced prevention of out-of-band GitHub merges.

`startup-role-pa` currently depends on manager-supplied summaries and assigned cues, has no own timer, and may be logically waiting. A PA must stay resident and be periodically woken with a scoped factual summary; continuous model token use is not the intended meaning of active. Manager/coordinator health needs explicit degraded/offline visibility.

## Verified local dependencies and prior art

OMP `18.8.9`; Herdr `0.9.5`; compatible running server; installed OMP integration current `v10`. Installed CLI is authoritative for syntax. Herdr `agent start NAME --kind omp --pane ID -- ARGS` needs an existing shell pane and returns only at interactive readiness. Herdr owns process/layout and user access, OMP owns execution/transcript, Startup owns business workflow. Herdr integration supplies native session references and lifecycle. Pane identity and employee identity are distinct; names disappear on process exit. Uncertain launch/prompt cannot be blindly retried. Herdr prompt wait is lifecycle-based, not per-job acknowledgement.

Prior-art verdict: adapt existing Herdr CLI/socket protocol and native OMP extension lifecycle; retain V6 store's durable inbox/outbox and lease rather than add another workflow dependency. No new service dependency beyond the explicitly requested coordinator and tools. Sources inspected 2026-10-15: https://herdr.dev/docs/agent-automation/ ; https://herdr.dev/docs/integrations/ ; https://herdr.dev/docs/session-state/ ; installed `herdr --help`, `herdr agent start --help`, `omp --help`. Live Herdr control from this Codex session is subject to `herdr --skill`'s HERDR_ENV=1 condition; only isolated owned tests may be used for destructive experiments.

## Result

Implemented candidate and proof are recorded in [acceptance](acceptance.md). New-state live Herdr boot, hierarchy, PA supervision, deadline faults and explicit manual resumes are proven in that report. Automatic restore and V6 migration remain explicit gates. Repository-level merge isolation is not required; the user controls shipping restrictions explicitly. The subsequent collection release is 7.0.0; companion installation remains an explicit named-profile action.
