# Startup V7 companion

The package entry is `v7.ts`. A detached coordinator owns Startup's SQLite state, launch identity, crew hierarchy and supervision. Each employee runs an independent OMP root in a directly interactive Herdr pane. The manager's inference or process can stop while the coordinator continues observing.

V7 currently supports new V7 state. It does not migrate a V6 database, reproduce V6 filesystem duty/repair tools, or provide automatic host reboot recovery. Live acceptance for new V7 state is recorded in [the acceptance report](../../docs/startup-v7/acceptance.md). `index.ts` and V6 probes remain historical/component evidence, not an alternate V7 boot path. The skill collection release is 7.0.5. Companion installation remains an explicit named-profile action.

The 7.0.2 [recovery proof](../../docs/startup-v7/recovery-acceptance.json) and [screenshot deck](../../docs/slides/startup-v7-recovery-2026-10-15.html) record a live local Herdr run with both session variables unset: a forced employee boot error alerted the manager, the original process recovered automatically in the same pane, PA reports continued, and all owned proof processes were shut down. This does not establish remote Linux compatibility or indefinite liveness.

## Requirements and installation

- Bun and OMP with native root sessions, persistent transcripts, `ctx.abort`, `isIdle()` and `hasPendingMessages()` support.
- A running Herdr server reporting client/endpoint compatibility, the required layout and agent APIs, and its managed OMP integration.
- An existing Herdr pane and socket context. Missing pane/workspace/session variables are resolved with `herdr pane current --current` and `herdr status server --json`; the default server reports a null session. No focused-pane discovery from outside Herdr.
- Canonical role/loop sources available locally. `OMP_PROFILE` or `PI_PROFILE` identifies the active manager profile; absent profile variables mean OMP's default profile. Employees use their saved launch profile when these variables are absent.

Use the existing binaries and the explicitly selected named OMP profile. Versions are diagnostic metadata, not compatibility gates: newer releases, including new major versions, are presumed usable until a required capability fails. OMP 18.8.9 and Herdr 0.9.5/protocol 22/integration v10 are the live-tested baseline, not required versions. Herdr 0.9.4 is accepted when its live APIs satisfy the same checks.

For the explicitly selected `startup-v7` profile, run from this repository:

```sh
bun install --cwd extensions/startup --frozen-lockfile
bun extensions/startup/install.ts install startup-v7
export STARTUP_HERDR_OMP_EXTENSION="$HOME/.omp/agent/extensions/herdr-omp-agent-state.ts"
OMP_PROFILE=startup-v7 omp --profile startup-v7 --extension "$STARTUP_HERDR_OMP_EXTENSION"
```

The integration path must be the actual managed file, with `HERDR_INTEGRATION_ID=omp` and a positive numeric `HERDR_INTEGRATION_VERSION` header. The revision identifies the managed file; it is not pinned to v10. `STARTUP_HERDR_OMP_EXTENSION` selects an explicit canonical path. Without it, entry uses `PI_CODING_AGENT_DIR/extensions/herdr-omp-agent-state.ts`, or `~/.omp/agent/extensions/herdr-omp-agent-state.ts`. Custom configuration locations should supply the explicit path. Worker launches load this integration before their generated Startup bootstrap and clear inherited `OMPCODE` so independent roots report their own lifecycle.

The installer links the package through native `omp --profile PROFILE plugin link`. `OMP_BINARY` selects the intended executable. Close that profile's sessions before changing installation; use the same profile/environment for installation and execution. `PI_CONFIG_DIR` must be a single directory name beneath the real home. Existing native XDG named-profile storage is respected. Installer checks, mutexes and ownership receipts refuse foreign or changed links/configuration.

Owned removal restores the saved prior lockfile bytes and retains Startup databases, history and unrelated plugins:

```sh
bun extensions/startup/install.ts uninstall startup-v7
```

Repository development does not install into a normal profile or upgrade an existing V6 Startup.

## Boot and input

In the original manager's Herdr/OMP root:

```text
/startup new NAME [--dir "absolute-or-relative-existing-path"] [-- WORK]
/startup select NAME [-- WORK]
/startup
/startup status
```

Names contain letters, digits, underscore or hyphen. `new` binds an existing directory, defaulting to native cwd. `select` reads the saved binding. Current selection discovers exactly one matching ancestor `.startup/config.md` binding or uses `STARTUP_NAME`. Startup home resolves `JP_SKILLS_HOME`, then `XDG_CONFIG_HOME/jp-skills`, then `~/.config/jp-skills`; state must remain outside the bound repository.

Boot verifies the actual OMP version, root identity, unparented transcript/header, canonical source hashes, named profile and Herdr location. It preserves unrelated root AGENTS/configuration bytes, records private runtime configuration and launch intent, then starts or reconnects to the independent runtime. A live or uncertain host is never blindly spawned again. Read-only health checks are bounded; partial PA startup failure keeps the endpoint available and records a manager blocker.

After a boot attempt, failed or incomplete admission blocks native and Startup tools. Source/turn admission failure invokes native abort; a swallowed extension hook exception does not grant work authority. Boot failure produces one stop reminder and then parks. The `/startup` command remains available for explicit correction/retry.

`-- WORK` preserves the exact original command text and images as the work receipt. Ordinary manager input remains unclassified until `startup_route`. Direct input in an employee pane becomes a durable manager observation with the original text/images; it does not change the employee's role or approval authority. Extension-generated notifications are not human receipts.

## Crews and tools

The hierarchy is manager -> owning architect -> dev/QA. PA and shared DevOps report to manager. Each event has an immutable team with one architect, one QA and one or more devs, grouped in one Herdr tab. Admission must verify every member before work claims become ready. A complete, finished, idle crew can be explicitly reused for another event with a fresh assignment/generation; membership history is retained.

Load the complete canonical [manager](../../skills/startup-role-manager/SKILL.md), assigned role and [shared loop](../../skills/startup-loop/SKILL.md). Native `task` remains OMP's bounded-helper tool. It is not overridden with Startup staffing modes. Helpers receive no employee admission and their factories install the employee-tool denial guard before attachment.

| Public tool | Purpose and boundary |
| --- | --- |
| `startup_hire {requestId,role,additional}` | Manager reserves additional architect/QA/dev/DevOps identities; stable retries add zero. The single permanent PA is automatic. |
| `startup_delegate {eventId,developers}` | Manager admits a complete crew for persisted intake; retries retain its original membership. |
| `startup_activate {employeeIds}` | Manager starts existing prepared identities; uncertain starts require reconciliation. |
| `startup_replace {employeeId,evidence}` | Manager replacement after explicit failure/identity evidence and unresolved-work reconciliation. |
| `startup_route {inputId,disposition,reason,amendItemIds}` | Manager classifies a saved native receipt as work/status/control/conversation/decision. |
| `startup_intake {eventId,input,amendItemIds}` | Manager saves externally supplied work before delegation. |
| `startup_claim {}` | Claims only the admitted employee's own ready inbox. |
| `startup_settle {claimId,result}` | Atomically saves result/checkpoint, acknowledgement and outgoing cues. |
| `startup_send {id,recipient,kind,correlation,payload}` | Persists a role-authorized hierarchical cue. |
| `startup_input {inputId,offset}` / `startup_image {inputId,index}` | Scoped 4096-character input pages and actual native image blocks; a preview is not the complete input. |
| `startup_capture {captureId,eventId,rows,receipt}` | Assigned architect captures canonical queue rows/revisions for its event. |
| `startup_item` | Typed flat item action with `requestId`, `itemId`, `expectedRevision` and action-specific fields. |
| `startup_staff {}` | Manager roster, crew hierarchy, runtime health, pending intake and unresolved recovery metadata. |
| `startup_reconcile {claimId,evidence}` / `startup_resolve {assignmentId,evidence}` | Manager evidence-based resolution of uncertain claims/assignments. |
| `startup_refresh {employeeId,evidence}` | Manager idle canonical-source refresh requiring fresh admission. |
| `startup_block {key,evidence}` | Manager records supported concrete capacity/dependency evidence. |
| `startup_finish_team {teamId,evidence}` / `startup_retire {employeeIds,evidence}` | Manager completion/eligible retirement after unresolved work, mail and grants are resolved. |

Result shape is `{id,kind,output,checkpoint,outgoing}`, with kind `completed`, `question` or `uncertain`. Outgoing cues use `{id,recipient,kind,correlation,payload}`. A question acknowledges its cue but retains the waiting assignment; an answer is not the original completed result. Follow [queue records](../../skills/startup-intake/references/queue-records.md) for block/decision, reconciliation, explicit resolution and a new attempt.

Independent QA proof precedes the owning architect's approval gate; manager alone records landing/completion. Other architects, workers, PA, helpers and observed idle/done states cannot approve progression. These are Startup workflow gates for recording review and completion. Shipping permissions follow explicit user instructions; repository-level merge denial and credential isolation are not V7 requirements.

## Capacity and supervision

`STARTUP_EXECUTION_LIMIT`, when supplied, is a positive safe integer constrained by the saved binding ceiling and must allow at least three root slots. Without an explicit ceiling, root admission derives the selected native `task.maxConcurrency` plus two reserved manager/PA slots. Coordinator permits bound root turns; ordinary helper concurrency remains OMP-local per root and is not aggregated into a global helper budget.

The coordinator has separate lease-renewal and serialized supervision timers. Default supervision ticks every second, PA checks are scheduled every 60 seconds with one outstanding check, semantic progress deadline is five minutes, and connection deadline is 30 seconds. The PA remains resident between checks; continuous inference is not required. PA settlement must include a manager report. Missing/offline/overdue PA supervision blocks new delegation and approval/landing while retaining existing history.

Observation collection failures, individual invalid observations and queue read failures are isolated and reported durably to the manager. Other observations, PA scheduling and independent deadline checks continue. `/health` exposes supervision start/completion/success timestamps and component errors, returns HTTP 503 for degraded or stale supervision, and recovers to HTTP 200 after a successful cycle. Degraded health does not disable the supervision timer. Employee polls read their own control state without loading unrelated global history.

Canonical queues support arrays and objects containing either `items` or `rows`. Capture and item transitions preserve that container and its unknown metadata. A document containing both keys is ambiguous and requires explicit repair. Coordinator restarts preserve crews, employee generations, native transcripts and history; interrupted active claims and held grants remain recorded for manager reconciliation rather than replaying work.

Herdr idle/done/blocked/unknown snapshots become timestamped durable manager alerts. Working state remains queryable without generating manager inbox traffic. Herdr state sequences are server-wide: forward jumps between observations of one employee are valid; regressions report a gap. Idle/done never settle a claim. Heartbeats and working animation never reset semantic progress. The watchdog checks claims, queue progression, unclassified input, employee presence, manager presence and PA deadlines. Polling can report gaps; it does not promise replay of every unseen intermediate lifecycle transition.

Employee polling updates control-presence metadata and injects durable own-inbox notifications through native `sendMessage`/next-turn delivery. It never types into the human composer or acknowledges work. Native `read`/`write` dispatch through `xd://startup_*` retains the same employee authority checks as named tools. Native `isIdle()` and `hasPendingMessages()` are required: idle roots release execution slots after recap/auxiliary requests, including after reattachment. Claims and settlements remain explicit. A coordinator-epoch rejection can reconnect the same credential/session metadata; uncertain command writes are never automatically replayed. A connection attempt briefly waits for the explicit no-commit HTTP 425 native-session-report-pending response.

Employee boot failures are handled inside the native hook, leave the pane interactive, and block unadmitted work. A readable diagnostic includes the CLI command, exit status and response when context discovery fails. A valid launch credential reports the failure immediately to the coordinator, which retains the launch and sends a durable `boot-failed` manager alert. Reporting failures are visible locally. Admission retries every five seconds in that same pane, or immediately with `/startup-retry`; retries stop after admission or shutdown. This retries binding, never crew creation, task execution or uncertain command writes. Manager boot errors remain visible and can be retried with `/startup new` or `/startup select` after correcting the reported problem.

## State and recovery boundaries

State is under `<home>/startup/NAME/`: `binding.json`, `staff.sqlite`, canonical queue/resource files, private `runtime-config.json`, `runtime-launch.json`, `runtime-launch.lock`, generated `launches/` manifests/bootstraps and `runtime.log`. Private runtime files are owner-only. Business history and runtime effects share the fenced store; lifecycle is observation evidence, not an alternate work log.

- V7 uses a distinct store host scope ending in `:startup-v7`. Existing V6 databases are refused even after their owner lease expires. There is no automatic scope rewrite or state import.
- Configured V6 duties block V7 startup. V7 does not expose V6 duty, filesystem repair, repair-authorization or grant-verification parity. Preserve that state for a separately designed migration.
- An interrupted prepared launch or retained launch lock requires explicit ownership/identity reconciliation. Do not create a second runtime to conceal uncertainty.
- The detached coordinator survives manager process loss, but it is not installed as an OS-supervised service. Automatic recovery from coordinator process death is not established.
- Coordinator restart fences unresolved work. Metadata reconnection restores the control channel; technical work remains blocked until saved uncertain claims/grants are reconciled. No uncertain mutation is replayed. Explicit claim reconciliation restores a ready crew to waiting only after all uncertain member claims/grants are resolved. Exact reconciliation retries retain their original evidence and do not reset completed assignments.
- Native restore must retain the named profile, explicit Herdr integration, generated bootstrap, bound cwd and original native root transcript. Preservation of those flags by Herdr/native restore remains unproven. Bare `omp --resume` is not acceptance evidence for employee admission.
- Live two-crew creation, direct pane input routing, real deadline fault detection, PA recovery and explicit same-transcript resumes passed on 2026-10-15. See [live evidence](../../docs/startup-v7/live-acceptance.json). Automatic Herdr restore, OS restart and V6 migration remain unverified/unsupported boundaries.

## Verification and evidence

```sh
bun run --cwd extensions/startup typecheck
bun test extensions/startup/tests
```

Tests use real SQLite and owned Unix sockets, fixture Herdr executables, and an owned detached runtime. They cover authority, complete crews, lifecycle without settlement, PA/progress deadlines, raw input/images, role routing, admission failures and installation ownership.

The compiled OMP guard probe uses an isolated offline provider and records executable/source hashes, admitted/denied/disconnected/synthetic stages and a guard-removal negative control:

```sh
python3 extensions/startup/probes/run-v7-guards.py \
  --evidence extensions/startup/probes/v7-native-guards.json \
  --omp-source /absolute/path/to/matching/OMP/src/extensibility/extensions/runner.ts
```

Inspect the artifact's actual status/checks and source hashes before treating it as current proof. [V6 acceptance](probes/v6-acceptance.md) remains historical evidence for the retained V6 implementation. No normal-profile installation, live Herdr control, publication or version change is implied by running repository checks.
