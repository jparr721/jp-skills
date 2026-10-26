# Startup V7 companion

The package entry is `v7.ts`. A detached coordinator owns Startup's SQLite state, launch identity, crew hierarchy and supervision. Each employee runs an independent OMP or Claude Code root in a directly interactive Herdr pane. Each of the six roles selects OMP or Claude independently; a prepared launch records that selection immutably. OMP setup follows; Claude Code setup is in [Claude Code](#claude-code). The manager's inference or process can stop while the coordinator continues observing.

V7 currently supports new V7 state. It does not migrate a V6 database, reproduce V6 filesystem duty/repair tools, or provide automatic host reboot recovery. Live acceptance for new V7 state is recorded in [the acceptance report](../../docs/startup-v7/acceptance.md). `index.ts` and V6 probes remain historical/component evidence, not an alternate V7 boot path.

The [manager recovery guide](../../docs/startup-v7/manager-recovery.md) covers automatic reconnection of the original manager transcript, bounded lifecycle alerts, honest connectivity health and finished crew retirement. A resumed manager must use its saved Herdr pane, Startup root and OMP profile with the managed Herdr integration loaded.

The 7.0.2 [recovery proof](../../docs/startup-v7/recovery-acceptance.json) and [screenshot deck](../../docs/slides/startup-v7-recovery-2026-10-15.html) record a live local Herdr run with both session variables unset: a forced employee boot error alerted the manager, the original process recovered automatically in the same pane, PA reports continued, and all owned proof processes were shut down. This does not establish remote Linux compatibility or indefinite liveness.

## Requirements and installation

- Bun 1.3.13 or newer (Unix WebSocket support) and OMP with native root sessions, persistent transcripts, `ctx.abort`, `isIdle()` and `hasPendingMessages()` support.
- A running Herdr server reporting client/endpoint compatibility, the required layout and agent APIs, and its managed OMP integration.
- An existing Herdr pane and socket context. Missing pane/workspace/session variables are resolved with `herdr pane current --current` and `herdr status server --json`; the default server reports a null session. No focused-pane discovery from outside Herdr.
- Canonical role/loop sources available locally. Managed OMP launches clear `OMPCODE` and select the Startup's recorded OMP profile (see [Profiles](#profiles)): `OMP_PROFILE` is set to it.

Use stock OMP and Herdr binaries. Startup does not fork or install either runtime. Select the canonical Startup root with `STARTUP_ROOT` (default: `<skills home>/startup/<name>`, where the skills home is `JP_SKILLS_HOME`, else `${XDG_CONFIG_HOME:-~/.config}/jp-skills`). OMP runs on its own configuration, resolved by OMP itself. The default profile uses the same agent directory a regular `omp` does (`~/.omp/agent`, or wherever `PI_CODING_AGENT_DIR`, `PI_CONFIG_DIR` and `XDG_DATA_HOME` move it), so its logins, `config.yml`, `mcp.json` and sessions are shared with your normal OMP. A Startup can instead run on a named OMP profile. Startup pins no agent directory and sets none of those variables. Startup authority remains under `STARTUP_ROOT`, separately from native configuration.

Repository development can load the extension directly after root provisioning:

```sh
bun install --cwd extensions/startup --frozen-lockfile
OMPCODE= omp --extension "$STARTUP_HERDR_OMP_EXTENSION" --extension "$PWD/extensions/startup/v7.ts"
```

Add `--profile NAME` to run the manager, and so the Startup, on a named OMP profile.

The integration path must be the actual managed file, with `HERDR_INTEGRATION_ID=omp` and a positive numeric `HERDR_INTEGRATION_VERSION` header. The revision identifies the managed file; it is not pinned to v10. `STARTUP_HERDR_OMP_EXTENSION` selects an explicit canonical path. It is required for either manager harness, because any role may launch an OMP employee. The Claude hook path is validated separately and is never passed to OMP as an extension. Worker launches load this integration before their generated Startup bootstrap and clear inherited `OMPCODE` so independent roots report their own lifecycle.

`install.ts` links the extension into an OMP profile and is not invoked by host control. Root provisioning and installed runtime changes require their own explicit operation.

## Profiles

A Startup runs on the OMP default profile or on one named profile. Boot records the manager's profile (`OMP_PROFILE`, else `PI_PROFILE`, else the default, as OMP resolves it) in the Startup's `runtime-config.json`, refuses to resume a saved manager under a different one, and launches every OMP employee on it: `OMP_PROFILE` is set in the pane so an inherited `OMP_PROFILE` or `PI_PROFILE` cannot select another profile. An employee refuses admission when its actual profile differs from that manifest. Native transcripts must live under `sessions/` in that profile's OMP agent directory.

`install` and `uninstall` take an optional profile:

```sh
bun extensions/startup/install.ts install [PROFILE]
bun extensions/startup/install.ts uninstall [PROFILE]
```

With no profile on a terminal, `install` asks for an OMP profile name (existing or new); Enter selects the default profile. It links with `omp plugin link` and `OMP_PROFILE` set to the profile, whether or not a named profile exists yet. The default profile's plugin directory is `~/.omp/plugins` (or `$XDG_DATA_HOME/omp/plugins` once that directory exists), so the extension is installed for your regular OMP. With no terminal and no profile, `install` uses the default profile, so a script or agent that means another profile must pass `PROFILE` (or `default`) explicitly. The ownership receipt records the profile as its name or `default`.

`config.ts` reads saved Startups under `<skills home>/startup`. A Startup saved in the old format (`binding.json` without `scope`) is skipped by `list` and refused by `get`:

```sh
bun extensions/startup/config.ts list                           # saved Startups, harness and profile
bun extensions/startup/config.ts get NAME [KEY]                 # runtime config, manager credential redacted
```

## Model roles

OMP employees launch with `--model @ROLE`, so each Startup role runs on one OMP model role from the manager's profile, unless that role's saved settings request a model, which replaces the bound role for that launch. The binding lives in `src/model-roles.ts`; the manager is launched by you, so it keeps whatever model you start it with:

| Startup role | OMP model role |
| --- | --- |
| architect | `plan` |
| dev | `slow` |
| qa | `advisor` |
| devops | `slow` |
| pa | `smol` |

Retune a model by assigning the role in the profile's `config.yml` `modelRoles` or with the `/model` role picker; Startup needs no change. `advisor` also drives OMP's advisor runtime, `plan` its plan mode, so a change applies to both uses. Subagents the dev spawns with `task` still use `modelRoles.task`.

Boot refuses to start when the profile cannot resolve a bound role (`ctx.models.resolve("@ROLE")`), naming each missing role and the Startup roles that need it. There is no fallback to `default`. Claude Code employees are unchanged and use the harness's own model selection.

## Claude Code

Requirements: Claude Code 2.1.302 or newer, Bun, Herdr's managed Claude integration (`$STARTUP_ROOT/hooks/herdr-agent-state.sh` with `# HERDR_INTEGRATION_ID=claude` and a numeric `# HERDR_INTEGRATION_VERSION`, registered as a SessionStart hook in `$STARTUP_ROOT/settings.json`), and root-scoped skills resolving into this checkout. Set `CLAUDE_CONFIG_DIR` to the selected Startup root.

```sh
bun install --cwd extensions/startup --frozen-lockfile
bun extensions/startup/install.ts install-claude
```

`install-claude` checks those requirements and writes `~/.local/bin/startup-claude` plus an ownership receipt. `uninstall-claude` removes both only when their bytes still match the receipt. The OMP `install|uninstall [PROFILE]` paths are unchanged.

Boot: open a Herdr pane in the bound root, run `startup-claude`, then type `/startup new NAME` (or `select NAME`, `status`, `-- WORK`). The bound root must be trusted in Claude Code (it or an ancestor has `hasTrustDialogAccepted`), and `STARTUP_EXECUTION_LIMIT` is required because Claude Code exposes no native helper concurrency. Startup runtime guidance stays under the selected root. Resuming a saved manager with a different harness is refused; new employee launches use each role's saved harness.

`startup-claude` resumes the saved manager session or starts a new one:

```text
claude --session-id UUID | --resume MANAGER_SESSION \
  --append-system-prompt-file <startupRoot>/startup/claude/manager.prompt.md \
  --settings <startupRoot>/startup/claude/settings.json \
  --mcp-config <startupRoot>/startup/claude/mcp.json -n startup-manager
```

Employees start with `herdr agent start NAME --kind claude --pane PANE -- --session-id LAUNCH_ID --append-system-prompt-file <state>/launches/LAUNCH_ID.prompt.md --settings <startupRoot>/startup/claude/settings.json --mcp-config <startupRoot>/startup/claude/mcp.json -n NAME`. They keep the user's default Claude setting sources and permission mode.

| OMP mechanism | Claude Code mechanism |
| --- | --- |
| Extension host and `startup_*` tools | `claude-bridge.ts` MCP server `startup` runs the unchanged employee bridge. Tools are `mcp__startup__startup_*`, loaded with ToolSearch `select:`. |
| Native session identity | Session UUID: the employee `launchId` passed as `--session-id`, matched against Herdr `agent_session {kind:"id"}`. |
| Role/loop system suffix | `--append-system-prompt-file`, checked against the admitted profile text each turn. |
| `begin_turn`, stop continuation | `mcp_tool` hooks: UserPromptSubmit, PostToolUse, Stop. |
| Tool guard | PreToolUse `command` hook `claude-pretool.ts` with `onFailure:"block"`: it asks the bridge over its socket, and any failure denies the tool. |
| `end_turn` and exact idle | Transcript end markers (`turn_duration`, interrupt row, StopFailure). |
| Idle wake via `sendMessage` | An `asyncRewake` waiter starts a task-notification turn; nothing is typed into the composer. |
| `/startup` command | UserPromptSubmit intercepts the raw `/startup` line before skill expansion. `/startup-retry` is not provided; the 5s retry and `/startup` cover it. |
| Human pane input receipt | Transcript human rows, including images, about 200 ms after submit. |

Known limits:

- Live state is injected as UserPromptSubmit/PostToolUse `additionalContext` only when it changes, and Claude Code persists it in the transcript; it is not ephemeral.
- Turn and receipt detection reads an undocumented transcript format. A turn without the expected rows fails loudly within 10s and blocks tools.
- Images typed directly in a pane are receipted from the transcript after submit; a bridge crash in that window loses the receipt. `/startup -- WORK` is receipted text-only, so send screenshots as a separate message.
- Claude Code honors `onFailure:"block"` only on `command` and `http` hooks. A failed UserPromptSubmit `mcp_tool` hook lets the prompt run without `begin_turn`; tool calls stay gated by the fail-closed PreToolUse command hook.
- A transcript ledger failure releases the held turn, blocks tools and refuses later turns until the pane is relaunched.
- The StopFailure pause and `interactive_ready` for crew reuse are not yet live-verified.
- Employees load the user's Claude hooks, plugins and MCP servers, the same trust model as OMP employees.
- A full manager boot runs inside one 120s UserPromptSubmit hook; a timeout falls back to the 5s retry.
- All employees share one Claude subscription's rate limits.
- A Herdr server restart that resumes with bare `claude --resume` loses the bridge, so the employee is never re-admitted.

## Boot and input

In the original manager's Herdr/OMP root:

```text
/startup new NAME [--dir "absolute-or-relative-existing-path"] [-- WORK]
/startup select NAME [-- WORK]
/startup
/startup status
```

Names contain letters, digits, underscore or hyphen. `new` binds an existing directory, defaulting to native cwd. `select` reads the saved binding. Current selection discovers exactly one matching ancestor `.startup/config.md` binding or uses `STARTUP_NAME`. Startup home resolves `JP_SKILLS_HOME`, then `XDG_CONFIG_HOME/jp-skills`, then `~/.config/jp-skills`; state must remain outside the bound repository.

Boot verifies the actual OMP version, root identity, unparented transcript/header, canonical source hashes, OMP profile and Herdr location. It preserves unrelated root AGENTS/configuration bytes, records private runtime configuration and launch intent, then starts or reconnects to the independent runtime. A live or uncertain host is never blindly spawned again. Read-only health checks are bounded; partial PA startup failure keeps the endpoint available and records a manager blocker.

After a boot attempt, failed or incomplete admission blocks native and Startup tools. Source/turn admission failure invokes native abort; a swallowed extension hook exception does not grant work authority. Boot failure produces one stop reminder and then parks. The `/startup` command remains available for explicit correction/retry.

`-- WORK` preserves the exact original command text and images as the work receipt. Ordinary manager input remains unclassified until `startup_route`. Direct input in an employee pane becomes a durable manager observation with the original text/images; it does not change the employee's role or approval authority. Extension-generated notifications are not human receipts.

## Crews and tools

The hierarchy is manager -> owning architect -> dev/QA. PA and shared DevOps report to manager. Each event has an immutable team with one architect, one QA and one or more devs, grouped in one Herdr tab. Admission must verify every member before work claims become ready. A complete, finished, idle crew can be explicitly reused for another event with a fresh assignment/generation; membership history is retained.

Load the complete canonical [manager](../../skills/startup-role-manager/SKILL.md), assigned role and [shared loop](../../skills/startup-loop/SKILL.md). Native `task` remains OMP's bounded-helper tool. It is not overridden with Startup staffing modes. Helpers receive no employee admission and their factories install the employee-tool denial guard before attachment.

### Public employee tools

The V7 OMP extension registers these tools through `HostAPI.registerTool`. Claude Code runs `claude-bridge.ts` as the MCP server `startup`; its `tools/list` publishes the same names, and Claude Code exposes them as `mcp__startup__startup_*` tools loaded with `ToolSearch` and a `select:` query. Both hosts use the shared employee registration and call the same owner commands. Tool visibility does not grant authority: calls require the admitted main/root session, and the coordinator checks role, employee identity, generation, assignment, claim, receipt, approval and review gates again.

This employee catalog is separate from the typed owner host-control lifecycle interface in [Owner host control and connection lifetime](#owner-host-control-and-connection-lifetime). Host lifecycle commands are not employee tools and cannot claim, settle, approve or impersonate an employee.

Every listed argument is required; zero-argument tools take `{}`. `string` and `number` show the published host schema. `JSON` is an unconstrained JSON value in the published schema. The owner applies stricter command validation before dispatch, including non-empty identifiers, positive safe counts, non-negative safe offsets/indexes, and action-specific result/capture validation. The Claude MCP schema builder reports JSON and native number fields coarsely, so callers must follow these owner constraints and inspect refusals. `startup_item` is the six-branch action union shown below.

| Public tool | Published input properties | Authority and result |
| --- | --- | --- |
| `startup_claim` | `{}` | Any admitted employee, including manager, claims only its own ready inbox. Returns the claim and message, or the owner's empty-inbox result. |
| `startup_settle` | `{result: {id, kind, output, checkpoint, outgoing}}`; `kind` is `completed`, `question` or `uncertain`; each outgoing cue is `{id, recipient, kind, correlation, payload}`. | Settles the caller's current claim with its receipt and cues. PA settlement requires a report cue to manager. |
| `startup_send` | `{id: string, recipient: string, kind: string, correlation: string, payload: JSON}`; `kind` is one of assignment, report, question, answer, alert or duty. | Persists a role-authorized hierarchical cue and returns its saved message record. |
| `startup_item` | One action: `assign` adds `employeeId,evidence`; `review` adds `resultId,evidence`; `qa_assign` adds `evidence`; `qa` adds `resultId,verdict,proof`; `gate` adds `verdict,evidence`; `decide` adds `status,evidence`. All variants include `requestId,itemId,expectedRevision,action`. `verdict` is `APPROVE` or `REDO`; `status` is one of `BLOCKED`, `NEEDS_DECISION`, `QUEUED`, `REJECTED`, `MERGED` or `DONE`. | Manager and assigned crew roles can make only their allowed action on the assigned item at the expected revision. Returns the durable item transition/result; architect review and manager landing gates remain required. |
| `startup_capture` | `{captureId: string, eventId: string, rows: JSON[], receipt: JSON}` | The assigned architect records canonical queue rows and revisions for its event. Returns the capture receipt. Owner validation requires each row to include `id`, nullable `expectedRevision` and `fields`. |
| `startup_staff` | `{}` | Manager only. Returns roster, team hierarchy, runtime/capability state, role settings and unresolved recovery metadata. |
| `startup_hire` | `{requestId: string, role: string, additional: number}`; `role` is one of architect, qa, dev, devops or pa. | Manager only. Reserves identities and returns the durable hire receipt; the single permanent PA is created automatically. |
| `startup_delegate` | `{eventId: string, developers: number}` | Manager only, with the required PA supervision gate. Delegates persisted intake and returns the reserved team. Launches continue serially; progress and uncertain launch alerts appear through `startup_staff`. |
| `startup_activate` | `{employeeIds: string[]}` | Manager only. Queues prepared launches and returns `{activated: employeeIds}`. Uncertain starts require reconciliation; a retry while launching is refused. |
| `startup_replace` | `{employeeId: string, evidence: JSON}` | Manager only. Reserves a replacement after explicit failure/identity evidence and unresolved-work reconciliation; returns the next generation. |
| `startup_intake` | `{eventId: string, input: JSON, amendItemIds: string[]}` | Manager only. Saves external work before delegation and returns the intake record. |
| `startup_route` | `{inputId: string, disposition: string, reason: string, amendItemIds: string[]}`; `disposition` is one of work, status, control, conversation or decision. | Manager only. Classifies a saved native input and returns the routed record. |
| `startup_input` | `{inputId: string, offset: number}` | Manager or assigned active crew with input scope. Returns a 4096-character page and continuation metadata. |
| `startup_image` | `{inputId: string, index: number}` | Manager or assigned active crew with input scope. Returns the actual saved image block. |
| `startup_reconcile` | `{claimId: string, evidence: JSON}` | Manager only. Resolves an uncertain claim and returns `{reconciled: claimId}`. |
| `startup_resolve` | `{assignmentId: string, evidence: JSON}` | Manager only. Resolves an uncertain assignment and returns `{resolved: assignmentId}`. |
| `startup_finish_team` | `{teamId: string, evidence: JSON}` | Manager only. Finishes an eligible team and returns the durable team result. |
| `startup_refresh` | `{employeeId: string, evidence: JSON}` | Manager only. Refreshes an idle employee's canonical role source and returns the new generation. |
| `startup_block` | `{key: string, evidence: JSON}` | Manager only. Records a supported capacity/dependency blocker and returns its alert record. |
| `startup_retire` | `{employeeIds: string[], evidence: JSON}` | Manager only. Retires eligible employees after unresolved work, mail and grants are resolved; returns the retirement receipt. |

`startup_item` variants are strict action objects. `startup_settle.result` is strictly `{id, kind, output, checkpoint, outgoing}`; `output`, `checkpoint` and cue payloads are JSON. `startup_capture.rows` is published as an array of JSON values but owner validation requires each row to be `{id, expectedRevision, fields}` with a nullable revision.

OMP success uses its native tool result: canonical JSON appears in `details` and as JSON text in `content`; `startup_image` uses a native image content block. OMP execution errors are thrown to the host. Claude `tools/call` returns `{content, isError:false}` on success: text results contain the command JSON, while image results use MCP image content. A schema, admission, role, generation, receipt, stale-operation or approval refusal becomes `{content:[{type:"text",text:<error>}], isError:true}`. Rejected or uncertain commands are not silently replayed after reconnect.

OMP reports supported live model/effort and cached catalog through the authenticated native-session heartbeat. Claude Code remains an interactive Claude Code process; its model/effort and catalog readback are typed unavailable when the CLI does not report them. Saved selections describe future launches and are not presented as effective live values.

Item assignment delivers its `evidence` verbatim as the current `directive`, separately from the original intake `snapshot`, and identifies the owning architect as `reportTo`. Put executable rework scope and acceptance in that directive. Dev assignment settlement atomically creates a linked `item-result` report to that architect even with `outgoing: []`; receipt replay cannot duplicate it. The dev still submits `startup_item review` with its saved completed result. Own-poll state supplies `STARTUP_ITEM_REVIEW` with the result ID/current revision and a continuation until review or explicit block. Questions and uncertainty retain their existing reconciliation procedures. Automatic reporting changes no approval authority.

Result shape is `{id,kind,output,checkpoint,outgoing}`, with kind `completed`, `question` or `uncertain`. Outgoing cues use `{id,recipient,kind,correlation,payload}`. A question acknowledges its cue but retains the waiting assignment; an answer is not the original completed result. Follow [queue records](../../skills/startup-intake/references/queue-records.md) for block/decision, reconciliation, explicit resolution and a new attempt.

Settlement selects the single outstanding claim inside the store transaction; agents do not copy claim UUIDs. The original result ID and exact payload recover a saved receipt even after another claim is active. Changed payload under the same result ID is rejected. Old clients may still send an explicit claim ID, or the literal `"current"` to select their own claim without copying it; an incorrect explicit ID is never silently corrected.

Settlement errors return `recovery: {code,retryable:false,action,employeeId,generation,claimId}` alongside the HTTP error/message. Missing claims, foreign ownership, stale generations, reconciliation, already-settled claims and result replay conflicts are distinct. A durable deduplicated `settlement-blocked` alert goes TO manager. Follow the corrective action instead of repeating a rejected request. New native clients suppress identical rejected settlement payloads locally, including retries that only change the result ID (except where an ID collision is the actual error), abort the duplicate turn and stop automatic stop/cue continuations for that blocked claim. Polling stays active. Corrected results can proceed; a successful settlement of the affected claim or observed claim-state change clears the guard. New ready inbox work also clears a no-claim guard; unrelated mail never clears an active rejected claim. Re-admission and heartbeats alone do not clear it. Existing processes must resume with the upgraded client for this native guard.

Independent QA proof precedes the owning architect's approval gate; manager alone records landing/completion. Other architects, workers, PA, helpers and observed idle/done states cannot approve progression. These are Startup workflow gates for recording review and completion. Shipping permissions follow explicit user instructions; repository-level merge denial and credential isolation are not V7 requirements.

## Capacity and supervision

`STARTUP_EXECUTION_LIMIT`, when supplied, is a positive safe integer constrained by the saved binding ceiling and must allow at least three root slots. Without an explicit ceiling, root admission derives the selected native `task.maxConcurrency` plus two reserved manager/PA slots. Coordinator permits bound root turns; ordinary helper concurrency remains OMP-local per root and is not aggregated into a global helper budget.

The coordinator has separate lease-renewal and serialized supervision timers. Default supervision ticks every second, PA checks are scheduled every 60 seconds with one outstanding check, semantic progress deadline is five minutes, and connection deadline is 30 seconds. The PA remains resident between checks; continuous inference is not required. PA settlement must include a manager report. Missing/offline/overdue PA supervision blocks new delegation and approval/landing while retaining existing history.

Observation collection failures, individual invalid observations and queue read failures are isolated and reported durably to the manager. Other observations, PA scheduling and independent deadline checks continue. `/health` exposes supervision start/completion/success timestamps and component errors, returns HTTP 503 for degraded or stale supervision, and recovers to HTTP 200 after a successful cycle. Degraded health does not disable the supervision timer. Employee polls read their own control state without loading unrelated global history.

Canonical queues support arrays and objects containing either `items` or `rows`. Capture and item transitions preserve that container and its unknown metadata. A document containing both keys is ambiguous and requires explicit repair. Coordinator restarts preserve crews, employee generations, native transcripts and history; interrupted active claims and held grants remain recorded for manager reconciliation rather than replaying work.

Herdr idle/done/blocked/unknown snapshots become timestamped durable manager alerts. Working state remains queryable without generating manager inbox traffic. Herdr state sequences are server-wide: forward jumps between observations of one employee are valid; regressions report a gap. Idle/done never settle a claim. Heartbeats and working animation never reset semantic progress. The watchdog checks claims, queue progression, unclassified input, employee presence, manager presence and PA deadlines. Polling can report gaps; it does not promise replay of every unseen intermediate lifecycle transition.

Manager `startup_claim` and native wake/continuation selection share an actionable priority order: current failures/questions, crew technical reports, then other unresolved alerts, with sequence preserved within each class. Selection reads only the recipient's pending inbox and unresolved claims. Routine PA reports and lifecycle observations stay durable but do not trigger manager inference. Current state proves recovery before stale presence/progress/item/input/settlement alerts are deferred; missing Herdr presence is distinct from fresh control polling. Unknown alerts remain actionable. `STARTUP_INBOX` exposes the deferred count, latest PA summary and the exact next selected message with `startup_claim {}`. This selection is already prioritized; no administrative walk is required. An outstanding claim clears the next-claim receipt. Deferred records remain pending with original IDs/payloads; they are not silently acknowledged or discarded. Other employee inboxes remain FIFO.

Employee polling updates control-presence metadata and injects durable own-inbox notifications through native `sendMessage`/next-turn delivery. It never types into the human composer or acknowledges work. Native `read`/`write` dispatch through `xd://startup_*` retains the same employee authority checks as named tools. Native `isIdle()` and `hasPendingMessages()` are required: idle roots release execution slots after recap/auxiliary requests, including after reattachment. Claims and settlements remain explicit. A coordinator-epoch rejection can reconnect the same credential/session metadata; uncertain command writes are never automatically replayed. A connection attempt briefly waits for the explicit no-commit HTTP 425 native-session-report-pending response.

The verified role and loop form a stable system-prompt suffix for the admitted root. Live checkpoint, team and claim state is an ephemeral user-role message appended after the existing conversation and tool results. It is not inserted before history or placed in a system/developer message: providers may normalize developer messages into their system prefix. Existing conversation messages remain unchanged, and the live-state message is replaced on the next model call rather than accumulated in native history. This preserves reusable prompt prefixes and OpenRouter's opening-message routing affinity. Cache reuse still depends on the provider and cache lifetime; a stable prefix is not proof of a measured provider cache hit. See [cache and volume evidence](../../docs/startup-v7/cache-and-volume.md).

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

## Host integration

Ronin, or any other local host, observes and drives a Startup through the coordinator's existing Unix socket. The socket is created mode `0600`. That file mode is the only authentication. There is no bearer token and no second credential. These routes are not employee commands: `POST /admit` remains native employee admission, and `GET /health` remains the launcher probe (`running` is HTTP 200, otherwise HTTP 503).

`GET /status` is strictly read-only. It does not record input, route, claim, renew the owner lease, replay queue intents, start recovery, or dispatch work. The body is HTTP 200 for every state. `storeRevision` is the current audit sequence. `observedAt` and `freshness` use the coordinator clock and the saved supervision deadlines. `setup` is derived from the saved scope, manager runtime, PA hire, PA runtime, and source-load receipts. Queue rows include their capture, transition, and host-receipt ids. Staff rows include employee id, role, generation, lifecycle, native root handle, and native session. Credential digests are omitted. Pending input is unclassified input that has not been withdrawn.

`state` is the first matching condition. `reasons` lists every match, in that same order.

| State | When |
| --- | --- |
| `unsupported` | A duty row exists or cannot be read. V6 duties are not migrated. |
| `recovery-required` | A queue intent is pending, the queue file is ambiguous or invalid, the manager binding failed, a manager runtime is uncertain or abandoned, or a claim, grant, or assignment is in reconciliation. |
| `missing` | The manager has no runtime yet. |
| `offline` | The manager runtime is not ready, its poll is stale, Herdr observed it offline, PA supervision is blocked, or the latest supervision pass recorded an error. |
| `stale` | The owner lease has lapsed, supervision last completed past the connection deadline, a watched item's recorded progress is past the progress deadline, or unclassified input is past that deadline. |
| `live` | None of the above. |

The response is capped. `limit` defaults to 32 and cannot exceed 64. `queueCursor`, `teamCursor`, `staffCursor`, and `inputCursor` are ids from the previous page. An unknown cursor is HTTP 403.

`POST /host/admit` accepts `{requestId, mode, origin, text, images}`. `mode` is `general`, `startup`, or `startup_outcome` and is stored on that input. Admit does not route, hire, delegate, launch, or dispatch; later activation has to read the saved mode. The same `requestId` and the same payload return the original receipt, including the original `receivedAt`. The same id with a different payload is HTTP 409. The receipt id is `admit:<requestId>`.

`POST /host/cancel` accepts `{requestOrItemId, intentId}`. It cancels one request before a queue row exists, or one queue row after it exists. A request cancel withdraws that input and leaves an already delegated crew running. An item cancel journals `CANCELLED` through the existing queue intent and settles only that item's saved execution generation and, when present, its QA generation. A claim for the same message in any other generation is refused before the cancel is written. The manager root is never settled, retired, or stopped. The same intent and target return the original receipt. A different pair under the same `intentId` is HTTP 409. The receipt id is `cancel:<intentId>`.

`GET /host/receipt/<id>` reads one of those receipts. An unknown id is HTTP 403. Receipt lookup does not apply intents or renew the lease.

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

## Owner host control and connection lifetime

`bun extensions/startup/host-control.ts` reads one JSON command from stdin (64 KiB maximum) and exits. It is a per-request owner entrypoint, not another daemon. `hostControlCommandSchema` is the authoritative request union. Every successful response is `{operation, result}`, validated by exported `hostControlResponseSchema` and typed as `HostControlResponse`. Receipt lookup returns a typed `found` receipt or `missing` request ID; mutation receipts validate their operation, state, effects and concrete result together. Every selected-root request includes the full canonical `scope` (`skillsHome`, `startupRoot`, `host`, `name`, `boundRoot`, `managerSession`). Ronin invokes this entrypoint and never opens SQLite itself.

A live `settings_apply` whose response is lost throws `HostControlUncertainError`. The CLI exits 1 and includes `outcome`, validated by `hostControlUncertaintySchema`: `{state:"uncertain", kind:"settings_apply", requestId, scope, replay:"forbidden", recovery:{kind:"receipt", requestId, scope}}`. Execute only that read-only recovery command. The uncertainty is not a committed receipt; lookup returns the owner's saved result when available. Pre-dispatch validation and read-only transport failures keep their original error types.

- `list`: configHome, after cursor and limit (1-100); reads `<configHome>/jp-skills/startup/*` (the default skills home; `JP_SKILLS_HOME` is not consulted), skips old-format roots (`binding.json` without `scope`) and works with zero owners.
- `create`: scope, requestId, skillsRoot, executionLimit, harness, expectedOwnerEpoch=0 and expectedRevision=0. Initializes a cold root; it does not manufacture a manager process.
- `select`: validates the binding and reads it without a lease or process start.
- `status`, `staff`, `progress`, `alerts`: optional bounded `query` with limit and queue/staff/team/input cursors. These reuse the typed host status, queue/team progress and supervision reasons. Offline state is explicit unavailable.
- `associations`: required `after` (null or last employee ID) and `limit` (1-64). Reads the live owner through `GET /host/associations?limit=64`; later pages pass `after`. Offline/archived owners return explicit unavailable.
- `settings`: saved future-launch selections and current connection-bound observations; optional limit and after launch cursor. Catalog/effective absence is unavailable, never inferred from requested settings.
- `settings_draft`: validates a selection without writing. `settings_apply`: requestId, expected owner epoch/store revision and baseSettingsRevision; receipt includes saved scope/provenance.
- `resume`: expected epoch/revision plus requestId. Observes the saved native manager identity before invoking the existing launcher. Missing identity is `missing_session`; a lost result remains `uncertain`. Neither outcome creates a replacement manager or retries an uncertain dispatch.
- `archive`: expected epoch/revision plus requestId. Preserves history and refuses a live owner, outstanding work or a saved launch intent. Shares the launch exclusion lock; an archived root cannot start an owner.
- `receipt`: read by requestId after a lost response. Identical replay returns the recorded result, conflicting payloads fail, and receipt lookup never re-executes a mutation.

`associations` exports `hostAssociationQuerySchema`, `hostAssociationRowSchema`, `hostAssociationPageSchema`, `HostAssociationRow` and `HostAssociationPage` from `src/runtime-contracts.ts`; the command/response unions and `executeHostControl` remain in `host-control.ts`. The observed page contains the full canonical scope, owner ID/epoch, store revision, owner-clock observation time, selected Herdr session, lease expiry, connection deadline, total, next cursor and bounded rows. `nextCursor` is the last returned employee ID; pass it unchanged. Unknown cursors fail. Pages are separate snapshots: re-read and compare owner/epoch/revision before using a selection; pagination is not an atomic multi-page snapshot.

A row with `status: "current"` publishes only its employee/role/generation, saved launch ID/harness, actual admitted native session/terminal ID, canonical source and last observation/poll times. It requires an exact connected owner/root/employee/generation/launch/harness/native-session record, matching source, ready/error-free runtime and fresh timestamps within the current owner lease. Other rows have `status: "unavailable"` and a typed reason, with no native target. The read uses one deferred SQLite transaction and does not renew a lease, observe native processes, launch, change settings or expose credentials, digests, connection epochs or bootstrap payloads. A ready admission itself records a native observation; manager rows may have no separate lifecycle state sequence.

This is a bounded persisted association, not a fresh native census or atomic native control. Startup supplies no `hostId`, `remote` or `bootId`. SYT-9099 owns composition with the configured/authenticated Ronin endpoint, comparing canonical scope and Herdr session plus a new native observation matching terminal ID, harness and exact native session. It must preserve the actually reported nullable native `bootId`, never substitute Startup epochs, reject stale/missing/ambiguous results and revalidate owner/generation/launch on selection. SYT-9103 consumes that shared bridge. Opaque native handles, names, pane labels and transcript suffixes are not identity sources.

Owner commands and reports require one current adapter connection epoch tied to owner, launch, generation, harness and native session. Admission is a long-lived Bun Unix WebSocket; existing command HTTP requests are authorized only while that channel remains current. Re-admission revokes the prior epoch. Disconnect/error, shutdown, native identity switch, retirement and owner replacement revoke old authority. Heartbeat expiry bounds undetected channel loss; it does not prove process death. An uncertain mutation is not replayed on reconnection, and committed receipts remain available.

OMP samples cheap model/effort state every heartbeat, caches catalog enumeration for 30 seconds, and invalidates on native identity or selected-model changes. Unchanged reports are not serialized or persisted every second. Reports carry increasing connection-scoped sequence numbers and the owner stamps receipt time; a future client clock cannot supersede another connection. Historical observations survive but are unavailable as current state after revocation.

Claude MCP hooks carry actual `session_id`; a missing or mismatched identity revokes admission. The command waiter supplies initial SessionStart identity because Claude skips MCP hooks before its server context exists. Later SessionStart (clear/compaction) validates identity and transcript; SessionEnd closes authority. Normal Stop/UserPromptSubmit waiter turnover does not revoke the MCP channel. Native hooks and transcript validation do not imply supported model/catalog readback; Claude readback remains explicitly unavailable. See [Claude hook lifecycle](https://code.claude.com/docs/en/hooks#mcp-tool-hook-fields) and [Bun Unix WebSockets](https://bun.com/blog/bun-v1.3.13).

Private root files and 0600 sockets establish the existing same-OS-user boundary. Launch credentials bootstrap admission and are not continuing authority; this does not isolate against a malicious process that can read every private owner file. Host control cannot impersonate manager claim/approval/settlement. Resource invocation delivery and remote endpoint transport belong to SYT-9106. Local fixture tests are not actual interactive OMP/Claude or remote Linux acceptance.

### New manager launch preparation

After cold create and any settings apply, call owner `prepare_manager` with scope, harness, requestId, expectedOwnerEpoch and expectedRevision before starting a new managed OMP manager. Its committed receipt supplies immutable saved manager settings and model/effort argv. Use those argv with the managed OMP launch; do not read mutable settings again. `prepareManagerLaunch` in `src/v7-launch.ts` is the same owner boundary used by `startup-claude`. Preparation freezes settings in the owner store and `manager-launch.json`, refuses a live owner or saved runtime through host control, and never starts a process. A lost preparation response is retrieved by requestId. Resume retains the existing native settings and never applies new model/effort flags. A directly started OMP process without preparation can only boot the unconfigured default manager selection; configured selections require this prelaunch step.

### Native artifact policy

OMP native sessions are the explicit shared-storage exception: managed sessions reside under `sessions/` in the Startup profile's OMP agent directory (`~/.omp/agent` for the default profile, `~/.omp/profiles/NAME/agent` for a named one, or the XDG data directory OMP substitutes for it), with an exact root-session header and current native API identity. This follows stock [OMP 18.11.1 directory resolution](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/utils/src/dirs.ts) and [SessionManager](https://github.com/can1357/oh-my-pi/blob/v18.11.1/packages/coding-agent/src/session/session-manager.ts). Startup does not copy native history or equate a transcript path with owner authority.

Claude launches select `CLAUDE_CONFIG_DIR=startupRoot`; transcripts must be under `projects/` there with the exact native session ID as their filename. [Claude's directory documentation](https://code.claude.com/docs/en/claude-directory) specifies this config override and transcript tree. Both harnesses reject foreign trees, noncanonical paths and symlink ancestors/files; resume retains the saved exact native session/file. Hook-provided Claude paths are checked before tailing. These source contracts still require current-version live acceptance.

### Durable input recovery

Each native session keeps an owner-only `input-receipts/<session-hash>.json` under its Startup root. The original event ID and payload are written before dispatch. A lost response leaves `uncertain`; a closed client before dispatch leaves `failed`. Both block further Startup work and preserve the input. `/startup-retry` revalidates native identity and checks the authenticated owner `receive_status` receipt by event ID and payload digest. A matching committed receipt clears the fence without resending. Missing/conflicting receipts remain blocked for explicit reconciliation; never delete the journal and replay an uncertain mutation. This internal read does not add an employee tool or change the 20-tool public catalog.

Repository verification runs frozen dependency installation, owner typecheck, the full extension test suite and Python probe-driver tests in `.github/workflows/startup.yml`. Fixtures are owner-regression evidence, not live native acceptance.
