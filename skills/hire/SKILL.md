---
name: hire
description: Use when the user requests Startup staff or the bound manager needs additional role capacity.
---

# Hire Startup staff

Only the user or bound manager authorizes hiring. Employees request capacity through their architect or manager. Exactly one manager exists; hireable roles are `architect`, `qa`, `dev`, `devops`, and `pa`.

1. Resolve the selected Startup through `../startup/SKILL.md` and its actual active-harness binding. Boot must already have refreshed root AGENTS. Load the complete canonical role and `startup-loop` using `../startup/references/role-dispatch.md`.
2. Interpret `hire devops 6` and `startup hire devops 6` as six additional employees. Two existing plus six becomes eight. Allocate one stable request ID for this intentional request; preserve it on retries. A later deliberate identical request gets another ID and adds six again.
3. Manager invokes `task {startup:"hire",requestId,role,additional}` with a positive count. Read requested/reserved/ready/starting/failed and individual IDs/errors. Reserved identities are not operational: report readiness only after actual native source-bound receipts.
4. Retry pending identities with `task {startup:"activate",employeeIds}`; do not issue another hire ID for a retry. Explain source, capacity or reconciliation blockers from actual receipts.
5. For new intake, prefer `task {startup:"delegate",eventId,developers}` after saving the raw event. It reserves/reuses the entire fresh assignment unit: one architect, one QA, one or more devs. Membership and developer count are immutable for that event; there is no add-member operation. Every distinct intake gets its own team and retries retain the original team.

Prefer more parallelism: reuse eligible idle staff or hire missing roles and dispatch independent ready teams within actual native capacity, budgets, dependencies, resource grants and explicit limits. Roster count differs from concurrent execution; reserve room for bounded pipeline/buddy/review turns. An absent explicit limit derives from native capacity, not a default six.

Shared DevOps is manager-scaled capacity. Hire authorizes no provision, monitoring target or repair. Assign supported duties with explicit target/probe/cadence/acceptance through the runtime contract in `../../extensions/startup/README.md`. Scale down with `startup_retire {employeeIds,evidence}` only after duties and unresolved work/mail/grants are resolved; retain identity/history.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` and follow it.
