# Startup role dispatch

## Purpose

Bind each Startup role to its canonical `startup-role-*/SKILL.md` before assigning work. A skill name in a prompt, a generic agent description, or a manager-written persona summary does not bind the role.

The manager loads `startup-role-manager` before handling any Startup command. It runs `startup-intake` in its own context as a procedure. Intake is not a spawned agent.

## Binding procedure

The current Startup session loads `startup-role-manager`. For each worker, architect, QA, DevOps, or PA child, bind its canonical Startup role skill. For a buddy child, bind its assigned canonical review skill:

1. Select the exact canonical role or skill ID, such as `startup-role-devops` or `pr-review-toolkit`, and load the complete corresponding `skills/<id>/SKILL.md`.
2. Prefer the harness's native named-role or skill-preload mechanism when it makes the complete canonical role available to the child before its task starts. A skill being discoverable or listed as available is not proof that it was loaded; a child-side skill load counts only when it occurs before task work.
3. If the harness has no usable preload, pass the complete role skill verbatim in the child's role-instructions block. Keep the item assignment, acceptance, and scoped constraints in a separate task-data block. Do not summarize, rewrite, or append persona language to the role source.
4. If the complete source cannot be read or bound, do not launch a generic substitute. Keep the item queued or mark the dispatch blocked, and report the missing role source or harness capability.
5. For each child, record the role ID, canonical source path, binding mode, native profile or child handle when available, and UTC dispatch time in `ledger.md`. Record the role's result or blocked reason against the same item.

Binding modes are `native-role`, `native-skill-preload`, and `verbatim-role-instructions`. Use exactly one mode per dispatch and record only the mode actually used. A child self-report is not binding evidence.

## Assignment data

The role is selected independently from its task. An assignment contains the item request and applicable fields such as:

```text
role: startup-role-devops
item: <queue-id>
task: Assess the resources and coordination requested for this item.
kind: <code|research|docs|ops>
acceptance: <expected result>
repo: <repo>
authorization: <explicit instruction or none>
constraints: <source-tagged, item-scoped constraints>
```

Do not add a `persona`, `role prompt`, or replacement `instructions` field. `kind`, `procedure`, acceptance, and role overrides remain task data. An override can add scoped constraints, but cannot replace the canonical role, its authority, its procedure, or its required output.

## Explicit role requests

For a user-requested built-in specialist, intake stores its canonical ID in the new row's `requested_roles` array. Missing `requested_roles` on an older row means an empty array. Do not rewrite old queue rows just to add the field.

The manager must dispatch every requested role before it reports that request fulfilled. Pending intake rows retain their role requests until ready. For ready `QUEUED` items requesting `coordinate with DevOps`, dispatch `startup-role-devops` after intake and before worker fan-out. `NO_ACTION` is a valid completed coordination result. A coordination request alone is not authorization to provision or mutate resources.

Record requested role dispatch and result in the ledger so a manager revival can distinguish completed coordination from work still pending. If the role needs a decision or authorization, follow the existing async boss and park rules; do not silently skip the requested role.

## Startup routing

| Work | Canonical source | Routing |
|---|---|---|
| Startup orchestration | `startup-role-manager` | Loaded in the current manager context before queue handling. |
| Intake | `startup-intake` | Procedure run by the manager in its own context. |
| Any queue item | `startup-role-dev` | One canonical worker role; `kind` and `procedure` select the work. |
| Buddy review | Kind-assigned review skill | Bind the complete canonical review procedure; the buddy reports only to the manager. |
| Item merge gate | `startup-role-architect` | Required for every item. |
| Per-item and overlap proof | `startup-role-qa` | Bind for per-kind proof and cross-item checks. |
| Environment/resources, or explicit user request | `startup-role-devops` | Bind for a resource trigger or every explicit request. |
| Every manager wake and outcome arrival | `startup-role-pa` | Run the reminder tick under its canonical role. |

Buddy review uses the assigned kind's canonical review procedure and the existing review-skill binding rules.

## Binding receipt

Use one compact ledger entry per dispatch and one result entry per return. Include no credentials or secret values.

```text
role-dispatch: item=<id> role=<canonical-role-or-skill-id> source=skills/<id>/SKILL.md binding=<mode> profile-or-handle=<value> at=<UTC>
role-result: item=<id> role=<canonical-role-or-skill-id> status=<role-result> handle=<result-handle-or-none> at=<UTC>
```

For a blocked dispatch, record `status=blocked` and a specific reason. Do not record a successful binding receipt when the source was only mentioned or when loading failed.

## Conformance scenarios

- `startup "Queue the cache fix, do intake, and coordinate with DevOps."` captures an item with `requested_roles: ["startup-role-devops"]`. Missing context leaves it pending. Once ready, the manager binds that role, records its result, then fans out the worker if no blocker remains.
- A task with no explicit role request and no resource trigger does not gain an inferred DevOps request.
- An explicit coordination request can complete with `NO_ACTION`; it cannot provision without separate authorization.
- An unavailable role source or unsupported binding produces a blocked dispatch, never a generic child with a newly authored role prompt.
- A previous queue row with no `requested_roles` remains readable and behaves as if it had an empty array.
- A worker for research, docs, or ops still uses `startup-role-dev`; the manager does not invent a per-kind persona.

The harness-specific binding mechanism varies. Use capabilities available in the active session and verify actual role loading; do not infer support from the harness name. See the rationale and framework research in `../../../docs/superpowers/specs/2026-10-13-startup-v5-role-binding.md`.
