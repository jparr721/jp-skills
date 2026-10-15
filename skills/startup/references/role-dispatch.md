# Startup role dispatch

## Runtime admission

OMP, Herdr and the Startup coordinator are mandatory. The coordinator owns durable workflow state; Herdr owns panes/processes; OMP owns execution/transcripts. An installed binary or a pane label does not prove admission. Every employee has one directly interactive Herdr pane and an authenticated, source-bound OMP root session. Missing runtime readiness blocks staffing instead of spawning through another harness.

## Binding

1. Load the entire `skills/startup-role-<assigned-role>/SKILL.md` and `skills/startup-loop/SKILL.md` from the canonical repository. The manager loads its manager role; every employee loads its assigned role. A named skill, discoverable profile, summary, or self-report does not prove loading.
2. Actual OMP context projection uses those exact source texts and hashes. Record real source paths/revisions, native session identity/generation, pane locator, assignment and admission receipt. Authenticated runtime identity determines the actor; tool arguments never select it. Missing/changed sources block admission until supported reconciliation/refresh; an old handle is not source readiness.
3. Keep request, acceptance, repo/base, kind/procedure, authorization and source-tagged overrides in assignment data. Preserve persona authority. Overrides apply only to their named item/repo; resolve global standing instructions, selected config preferences, then repo/role guidance without granting new authority.
4. Record canonical role/procedure ID, source path, actual binding mechanism/handle, UTC time, result or concrete blocker in the ledger. Runtime launch intent precedes external process startup; ambiguous outcomes remain uncertain until matching evidence resolves them.

## Routing

| Work | Binding and route |
| --- | --- |
| High-level human decisions, team capacity, authorization, landing | Current `startup-role-manager` |
| Each distinct intake event | Fresh complete team; `startup-role-architect` runs full `startup-intake`, leads devs/QA, reports only to manager |
| Item execution | `startup-role-dev`, assigned kind/procedure; reports to own architect |
| Required item proof | Own `startup-role-qa`; reports to architect |
| Buddy/depth review | Ordinary bounded OMP helper with complete assigned canonical review source; reports to architect or its assigned pipeline supervisor within the team |
| Resource/explicit DevOps request | Manager relays team's unchanged technical request/authorization to shared `startup-role-devops` |
| Supervision reminders | Mandatory resident `startup-role-pa` receives own scoped cues/coordinator summary and reports to manager |

Manager uses `startup_hire`, `startup_delegate`, `startup_activate` and `startup_replace` for employee management. Crew membership determines manager -> owning event architect -> dev/QA hierarchy, not OMP root parent IDs or pane names. Humans may interact directly with each pane without promoting its role or bypassing approval gates.

Ordinary OMP `task` pipeline supervisors/buddy/review helpers consume their OMP root's local helper capacity, separately from coordinator root-turn slots. There is no aggregate cross-root helper enforcement. Helpers have no employee admission, durable employee inbox, staffing or workflow approval authority. Explicitly bind their complete assigned canonical procedure before work. Shipping restrictions must come from the user; helper status alone neither grants workflow approval nor requires repository credential isolation.

Intake retains every explicit canonical role request in `requested_roles`; older rows without it behave as `[]`. Ready items fulfill requested specialists before the affected execution starts. Explicit DevOps coordination returns READY, NEEDS_INPUT or NO_ACTION; assessment alone authorizes no provisioning. Existing complete team members fulfill their own requested role; external specialist capacity goes through manager. A team has immutable membership; use new intake/team assignment when new scope requires one.

The architect preserves required buddy review, per-kind QA and bounded architectural APPROVE/scoped REDO gates. QA APPROVE supplies evidence; only the owning architect approves its gate and only manager approves final landing/acceptance. These permissions govern recorded workflow progression. Shipping restrictions come from explicit user instructions; V7 does not require repository-level merge denial or credential isolation. A user-authorized shipping agent reports its result through the crew so manager can record completion.

The coordinator saves observed Herdr idle/done transitions as durable system messages to manager. Lifecycle state never settles a claim, accepts work or approves a merge. PA source admission and continuing supervision gate new delegation/landing; degraded supervision leaves independent existing safe work eligible to continue. Binding/activation retries preserve identities and pending work; missing source, capacity or runtime health remains an explicit blocker.
