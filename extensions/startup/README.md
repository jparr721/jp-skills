# Startup companion

## Install and remove

Requires Bun and supported OMP 18.8.9. This package exposes `omp.extensions: ["index.ts"]` to native plugin discovery. Link canonical skills separately using the repository instructions; skills-only installation does not provide runtime persistence.

Choose an explicit named OMP profile. Close its running OMP sessions before changing installation. From this repository:

```sh
bun install --cwd extensions/startup --frozen-lockfile
bun extensions/startup/install.ts install my-startup
omp --profile my-startup
bun extensions/startup/install.ts uninstall my-startup
```

The installer runs native `omp --profile <profile> plugin link <package-directory>` only after ownership checks. `OMP_BINARY` may identify the intended OMP executable. `PI_CONFIG_DIR` is a single directory name beneath the real home; named-profile plugin data normally lives there under `profiles/<profile>/plugins`. On macOS/Linux an existing `$XDG_DATA_HOME/omp/profiles/<profile>` selects native XDG plugin storage. An agent-directory override alone does not isolate plugins. Use the same profile and environment for install, execution and uninstall.

Installation refuses an existing foreign package path, native dependency, plugin entry/settings or changed ownership receipt. Uninstall verifies the owned link and exact saved lockfile, restores its prior bytes and removes only the owned link/receipt. Changed installation files require explicit reconciliation; no force overwrite. An interrupted owned link can be removed with the same uninstall command before retrying. It retains all user profiles, configuration, transcript/history, Startup staff/state, generated employee profiles and unrelated plugins. Normal-profile installation is not part of repository development or acceptance.

## Native boot

The installed companion registers `/startup` even before selection:

```text
/startup new <name> [--dir <JSON-double-quoted-path>] [-- <work>]
/startup select <name> [-- <work>]
/startup
/startup status
```

Names contain letters, digits, underscore or hyphen. The directory must exist. New defaults to actual native cwd. Select reads `<JP_SKILLS_HOME>/startup/<name>/binding.json`; current boot discovers exactly one saved binding for the nearest ancestor `.startup/config.md`. Ambiguous legacy prose is preserved and requires explicit selection. Startup home resolves `JP_SKILLS_HOME`, then `XDG_CONFIG_HOME/jp-skills`, then `~/.config/jp-skills`. State must be outside the bound root.

Boot checks actual running `pi.pi.VERSION`, writes a synchronous managed root AGENTS section beside `.startup`, preserves unrelated bytes/config, materializes the real native root transcript when lazily allocated, and only then starts the adapter. Bound root and native cwd are distinct: employee discovery profiles live at actual native cwd `.omp/agents`. Foreign profile/AGENTS ownership fails explicitly. On a boot error retained input/tool/stop guards prevent ordinary work; correct the reported files/config and retry `/startup`. Known OMP with failed companion stays blocked under the canonical dispatch contract.

`-- <work>` retains the exact original native human input and attached images, routes its receipt as work and wakes the manager to delegate it. Command words are part of the retained raw evidence. A boot without work records a control receipt. Ordinary later human input remains unclassified until manager `startup_route`; registered commands are control. `STARTUP_NAME` is an optional explicit host selection, not required boot syntax.

`STARTUP_EXECUTION_LIMIT` is absent or a positive safe integer. The effective explicit ceiling is the smaller of it and saved `binding.json.executionLimit`; native execution capacity further bounds admission, including bounded review/buddy descendants. No absent-limit default of six. Invalid values retain boot guards and fail before store effects; correct the host environment and restart to clear an invalid host configuration. Roster reservation and concurrent execution are different.

## Public tools

Load complete canonical [manager](../../skills/startup-role-manager/SKILL.md), assigned role and [shared loop](../../skills/startup-loop/SKILL.md). Role text is the sole persona source; assignment payloads stay separate. `task` retains native ordinary-task grammar and adds:

```text
task {startup:"hire",requestId,role,additional}
task {startup:"activate",employeeIds}
task {startup:"delegate",eventId,developers}
task {startup:"replace",employeeId,evidence}
```

Hire/delegate/activate/replace are manager-only. Hire is additive, stable request ID retries add zero, a deliberate later hire uses a new ID. Ready requires actual native canonical-source admission. Both native asynchronous progress and synchronous results are supported without changing OMP settings. A failed later single dispatch retains earlier successful siblings. Correct a source/profile preparation error and retry the same IDs; a changed idle hire source requires explicit `startup_refresh` before team reservation. Each intake event has a fresh complete unit with exactly one architect, one QA and one or more devs. Team membership and developer count are immutable. Reuse idle staff or hire missing capacity, dispatch independent ready teams and sweep before waiting. PA has only its own scoped inbox and manager-provided summaries.

| Operation | Boundary |
| --- | --- |
| `startup_route {inputId,disposition,reason,amendItemIds}` | Manager high-level disposition; work immediately delegates. |
| `startup_intake {eventId,input,amendItemIds}` | Manager saves raw externally supplied work, then delegates. |
| `startup_claim {}` / `startup_settle {claimId,result}` | Own inbox only; result `{id,kind,output,checkpoint,outgoing}`; completed/question/uncertain. |
| `startup_send {id,recipient,kind,correlation,payload}` | Persist authorized hierarchical cue before native wake. |
| `startup_input {inputId,offset}` / `startup_image {inputId,index}` | Assigned input pages up to 4096 characters and native image blocks; 512-character preview is not full intake. |
| `startup_capture {captureId,eventId,rows,receipt}` | Assigned architect scoped queue capture; exact row/revision contract in [queue records](../../skills/startup-intake/references/queue-records.md). |
| `startup_item` | Typed role-authorized execution, QA, architect gate and manager landing. Read queue records before using. |
| `startup_staff {recoveryOffset?}` / `startup_dispatch {messageIds}` | Manager staffing, source readiness, capacity/blockers and saved-message wake. Recovery pages expose up to 64 unresolved claims, grants, assignments and pending delivery IDs each, with counts and `nextOffset`; no task bodies. |
| `startup_block {key,evidence}` | Manager records validated concrete capacity/resource/dependency evidence. |
| `startup_reconcile {claimId,evidence}` / `startup_resolve {assignmentId,evidence}` | Manager evidence-based uncertain claim and assignment resolution. |
| `startup_refresh {employeeId,evidence}` / `startup_bind_manager {}` | Idle source refresh or current-root manager recovery; real source admission required. |
| `startup_release_reconciled {grantId,verification}` | Current root verifies reconciled grants; JSON repair grants require actual native verification. |
| `startup_finish_team {teamId,evidence}` / `startup_retire {employeeIds,evidence}` | Manager only after unresolved work/mail/claims/grants/duties are resolved; retirement limited to idle DevOps. |

Question settlement acknowledges its cue but preserves its waiting assignment. A later answer never completes the original item result. Use the explicit block/decision, reconcile if uncertain, resolve, requeue and new-attempt sequence in queue records. Never replay an uncertain mutation automatically.

## Monitoring and repair

Only the current host owns timers; offline means no monitoring. This version supports regular filesystem JSON documents up to 16384 bytes with complete LF-terminated native read evidence. It has no deployment/service-health connector. A matching file acceptance condition proves that condition only.

- Manager assigns `startup_duty {id,employeeId,target,probe,acceptance,repairAuthority,cadenceMs,nextDue}`; missing fields are explicit null and remain pending. Target and probe are absolute regular `.json` file paths without selectors or hard links. Acceptance is `{path: string[], equals: JSON}`. Authority is null, `{kind:"read-only"}`, or `{kind:"replace-json",payload:JSON,verification:{path:absoluteJsonPath,acceptance:{path:string[],equals:JSON}}}`. Cadence is a positive integer milliseconds value at most 2147483647; nextDue is an epoch-millisecond timestamp. Never infer a production target or repair authority from hiring.
- Manager reads `startup_duties {}` for host lifetime, due/pending duty and timestamped observation/blocker state, then sends a scoped summary to PA. Historical observations are not current health.
- Duty IDs and configured authority are immutable. End resolved old duty with `startup_duty_end {dutyId,evidence}`, then use a new ID for a changed duty.
- Manager `startup_repair_authorize {id,dutyId}` saves one exact configured replace-json action and assigned post-action probe. The assigned employee alone invokes `startup_repair {authorizationId}`. No employee-selectable target, payload or binding arguments.
- Existing grants, including released ones, cannot replay repair. A new deliberate action needs a new authorization ID. Uncertain action requires manager `startup_repair_reconcile {grantId,evidence}` and an actual new native verification probe before grant release; reconciliation never repeats the write.

## Verification

`bun run --cwd extensions/startup typecheck` and `bun test extensions/startup/tests` run local checks. Compiled native probe evidence is retained under `probes/`; offline fixture providers exercise the real installed OMP runtime without external services. Installation, source admission and file probes do not establish production deployment health.

## Cold recovery and acceptance proof

Resume the same saved manager native transcript with the same named profile and isolated environment used to install and boot it:

```sh
omp --profile my-startup --resume /absolute/path/to/saved-manager.jsonl
```

The cold probe uses this exact `--resume` form; the installed boot probe also verifies `--session <saved-file>`. Starting a brand-new root with `startup select` is not same-session recovery. After the real default 60000 ms owner lease expires, the current owner calls `startup_staff {}` and follows `recovery.nextOffset` with `startup_staff {recoveryOffset:nextOffset}` to discover saved claim, grant, assignment and pending-message IDs, reconciles uncertain work with fresh native verification, binds its current manager source and uses `startup_dispatch {messageIds:[savedId]}`. No uncertain mutation is replayed. Preserved child transcripts and source admission retain employee identity; runtime observations resume only while the new host runs.

Generated technical employee profiles declare native `spawns: [task]` for bounded procedure supervisors/reviewers. Native recursion, disabled-agent policy, budgets and aggregate capacity still apply. Ordinary helpers receive no Startup employee identity or inbox/hiring authority; PA retains no child-spawn permission.

[V6 acceptance](probes/v6-acceptance.md) contains reproducible owned-fixture commands, fingerprints, current proofs and reused component boundaries for VERSION 6.0.0. Normal-profile installation remains an explicit separate action.
