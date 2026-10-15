---
name: hire
description: Use when the user requests Startup staff or the bound manager needs additional role capacity.
---

# Hire Startup staff

Only the user or bound manager authorizes hiring. Employees request capacity through their architect or manager. Exactly one manager and one permanent PA exist. Coordinator startup automatically reserves the PA; additional PA hiring is rejected. Hireable roles are `architect`, `qa`, `dev`, and `devops`.

1. Resolve the selected Startup through `../startup/SKILL.md` and its admitted OMP/Herdr coordinator binding. Boot must already have refreshed root AGENTS. Load the complete canonical role and `startup-loop` using `../startup/references/role-dispatch.md`.
2. Interpret `hire devops 6` and `startup hire devops 6` as six additional employees. Two existing plus six becomes eight. Allocate one stable request ID for this intentional request; preserve it on retries. A later deliberate identical request gets another ID and adds six again.
3. Manager invokes `startup_hire {requestId,role,additional}` with a positive count. Read requested/reserved/ready/starting/failed and individual IDs/errors. Each employee needs its own Herdr pane and admitted OMP session with complete canonical source. Reserved identities are not operational.
4. Retry pending identities with `startup_activate {employeeIds}`; do not issue another hire ID for a retry. Explain source, capacity or reconciliation blockers from actual receipts. Ambiguous launches require reconciliation before retry. For a proven failed process use `startup_replace {employeeId,evidence}`; preserve identity/history and reconcile unresolved work before accepting the new generation.
5. For new intake, use `startup_delegate {eventId,developers}` after saving the raw event. It creates an event-scoped crew with one architect, one QA and one or more devs. It reuses only a whole finished crew with exactly the requested developer count, every runtime ready and observed idle/done, and no active turn, employee/runtime error, active assignment, unresolved mail, claim or grant. Otherwise it reserves new crew employees; arbitrary idle individuals are not pooled. Membership and developer count are immutable for that event; retries retain the original crew.

The mandatory PA is source-admitted and permanently supervised while Startup runs. Healthy scheduled waiting is valid; PA process loss or missed supervision degrades Startup and blocks new delegation/landing until recovery. Ordinary OMP `task` is a bounded helper only; it never creates employees or grants merge authority.

Dispatch independent ready crews within coordinator root-turn slots, budgets, dependencies, resource grants and explicit limits. Root admission reserves manager/PA capacity separately from technical roots. Each OMP root enforces its own local helper capacity; the coordinator does not aggregate helper usage across roots. Roster size, root-turn slots and local helper limits are distinct.

Shared DevOps is manager-scaled capacity. Hire authorizes no provision, monitoring target or repair. Assign supported duties with explicit target/probe/cadence/acceptance through the runtime contract in `../../extensions/startup/README.md`. Scale down with `startup_retire {employeeIds,evidence}` only after duties and unresolved work/mail/grants are resolved; retain identity/history.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
