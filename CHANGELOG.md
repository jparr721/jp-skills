# Changelog

`VERSION` at the repo root is the version source of truth. The installed copy lives in `<canonical-home>/config.json` (`installed_version`); canonical home is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`.

## [7.8.0] - 2026-10-27

### Added

- `ask`: hand-invoked codebase conversation with source-grounded answers, follow-up discussion, and explicit read-only boundaries. `/ask` (OMP: `/skill:ask`) does not edit files, run builds/tests, create tickets, or start implementation unless the user explicitly leaves discussion mode.
- Six offline contract checks for Ask's invocation, persistence, evidence requirements, read-only boundaries, catalog entry, and selected-profile Hermes upgrade guidance; an executable regression test checks both documented link commands against existing directories, files, valid/dangling links, repeat runs and a selected Hermes profile.

### Changed

- Upgrades now include the selected Hermes profile alongside the five existing harness registries. Preserve real local skills and other profiles, detect local shadowing of external skills, and verify actual discovery rather than symlink existence alone. Installation documentation includes Hermes.
- Upgrade preflight distinguishes an installed Herdr binary from an active Herdr session; recommend installation only when the binary is missing.

### Verification

- 23 Python skill/storage tests, 6 Python Startup driver tests, Startup TypeScript checking, and all 641 Startup tests (3072 assertions) pass locally.
- The installed Hermes skill loader discovers `ask` from the shared checkout and reports it available. Contract tests check instructions, not a technical tool sandbox; no installed Startup runtime changes or session restarts are claimed.

## [7.7.0] - 2026-10-26

### Added

- Private GitHub state storage, default `jp-skills-storage`, with `server-maintenance/ledger/` and future skill namespaces. Agents assume authenticated `gh`, ask once for the repository choice, create or clone it themselves and verify private visibility.
- Timestamped per-field facts and UUID-keyed operation events. The shared cleanup post-run hook commits, fetches, reconciles all ledger documents, pushes and reads back the exact remote SHA; independent facts/events survive and overlapping values use the newest timestamp. Offline failures keep local work; there is no force-push.
- Every upgrade checks storage migration even at the same installed version: import and verify legacy connection/operations Markdown, retain full source text and honest timestamp provenance, deduplicate retries and record completion only after verified sync. Sources remain recovery copies.
- Offline storage unit/integration tests using real divergent Git clones and bare remotes; GitHub setup tests are offline.

### Changed

- Maintenance now writes the private JSON ledger rather than local Markdown logs; every new fact, event and receipt has a timezone-qualified timestamp.
- Included pending maintenance guidance for local disk/Immich assessments, SSH/host pressure and service-sync incidents; pipeline guidance for selected tracker access, publication ownership, exact-source CI evidence, QA and tracker closure; upgrade guidance for explicit Git reconciliation, ownership-safe relinking and runtime/profile selection.

### Verification

- Storage: 16 offline tests pass, including divergent clones, private push destinations, staged-only facts, ignored ledgers and empty-origin initialization. Real private storage creation, 34-file legacy migration and exact remote ledger content/SHA readback verified.
- Release qualification: Startup TypeScript checking passes; 641 Startup tests (3072 assertions) and 6 Python driver tests pass. No live installed-runtime upgrade or profile/session restart is claimed.

## [7.6.0] - 2026-10-25

### Added

- Each of the six Startup roles can select OMP or interactive Claude Code with separately saved model/effort requests. A Startup's root is `<skills home>/startup/<name>`; typed requested, saved and effective values preserve unavailable readback instead of inferring runtime state.
- A typed owner host-control entrypoint supports list, create, select, resume, safe archive, bounded status/staff/progress/alerts, settings draft/apply/readback and receipt lookup without direct database access or employee impersonation.
- The OMP extension and Claude Code MCP bridge publish the verified 20-tool `startup_*` employee catalog. The reference documents their published schemas, owner validation, results, errors and role gates separately from host lifecycle control.
- Employee authority and settings observations are bound to the current native connection epoch. Re-admission, disconnect, shutdown, session change, retirement and owner replacement revoke old authority; uncertain writes are not replayed.
- Every skill except the terminal `cleanup` tail starts with a Herdr preflight: inside a pane (`HERDR_ENV=1`) it may control panes through the `herdr` CLI; outside one it says so once, recommends `curl -fsSL https://herdr.dev/install.sh | sh`, and continues in-process. `startup` uses a mandatory variant: Herdr absence blocks boot, matching its existing coordinator/PA requirement.
- `dark-factory` is Herdr-aware: `HERDR` (auto/required/off), `WORKER_AGENT` (same or an explicit `herdr agent` kind such as codex, claude, omp), `PANE_LAYOUT` (tab-per-ticket/run-tab/workspace), `PANE_FOCUS`, and `WORKER_TIMEOUT`. The principal allocates, launches, polls, collects from, and closes one pane per worker (planner, per-ticket sub-orchestrator, stack driver, ephemeral fix/rebase agents) and records ids in the ledger. The context firewall now allows only the outcome block from the pane or an outcome file, and the outcome schema carries a diagnostic `herdr:` line.

### Changed

- Startup runs OMP on OMP's own configuration, with nothing pinned: the default profile shares the same agent directory a regular `omp` uses, and a Startup can run on a named OMP profile instead. A Startup records its profile, every OMP employee launches on the profile in its launch manifest (`OMP_PROFILE` set in its pane), and managed transcripts must live under that profile's OMP agent directory.
- `install.ts` asks for a named OMP profile (existing or new) or Enter for the default profile; with no terminal it installs into the default profile.
- `config.ts set` and `config.ts profiles` are removed: a Startup's profile is fixed when it is created, because its manager transcript lives under that profile's OMP agent directory.
- Name-less Startup discovery, host-control `list` and `config.ts list` skip old-format Startup roots (`binding.json` without `scope`) instead of failing.
- An OMP employee still launches on the OMP model role bound to its Startup role, unless its saved settings request a model, which replaces the bound role for that launch. Manager boot checks the bound roles only for a fresh admission.

### Verification

- Scoped Startup typecheck, registration/catalog tests and role-refusal tests are recorded in the SYT-9095 Slice D runrecord. Full merge-gate verification remains CI-only; interactive OMP/Claude and installed-runtime acceptance are not claimed by the local test lane.
- The merge of 7.3.0 to 7.5.0 into this work was resolved without running the test suite; run the Startup suite before release.
- All Herdr commands and JSON fields re-checked against herdr 0.9.5 (`herdr --skill`, `herdr agent|pane|tab|workspace`, `herdr status server --json`); launch shape matches `extensions/startup/src/herdr-runtime.ts`.
- Preflight coverage: `grep -L "## Herdr preflight" skills/*/SKILL.md` returns only `skills/cleanup/SKILL.md`.
- Live smoke in an isolated named Herdr session (0.9.5): workspace create -> `agent start --kind omp` (ready, correct pane/kind) -> prompt -> `SMOKE-OK` read back -> agent listed -> workspace close -> session stop. Absent-Herdr path exercised from a plain shell. The in-pane path (`HERDR_ENV=1`) uses the same socket commands.

## [7.5.0] - 2026-10-19

### Added

- `quickfix`: a hand-invoked fix-it-now mode, the ungated sibling of `hotfix`. Each request is edited in place on the checked-out branch beside any dirty files; it asks only when a missing fact blocks the edit (one batched message, each question with a recommended default), fixes at the root with the repo's own helpers, reports sibling defects and pre-existing red for you to call, and leaves edits uncommitted. It is `disable-model-invocation`, so it never competes with `hotfix`; OMP surfaces it as `/skill:quickfix`.

### Verification

- Pressure-tested with subagents in scratch repos under the superpowers session-start rules: a plain agent committed unasked on the feature branch and asked an open-ended brainstorming question; with `quickfix` the same requests produced uncommitted in-place edits and one batched question with defaults, with no brainstorming or worktree skill read. One run per scenario.

## [7.4.0] - 2026-10-17

### Added

- `install.ts install|uninstall` take an optional profile: with none, the only saved named OMP profile is used, otherwise a terminal prompt picks one of the saved profiles.
- `config.ts` lists saved OMP profiles and Startups, reads a saved Startup's runtime config with the manager credential redacted, and switches a Startup's OMP profile after the fact. A switch refuses while the coordinator runs or its launch is uncertain and prints the resume command for the new profile.

### Changed

- Each employee launch uses the profile recorded in its launch manifest instead of the live coordinator config, so a switch cannot split one launch across two profiles.

### Verification

- 510 tests, 2544 assertions, and TypeScript checking pass.
- Resume by path under another profile appends to the original manager transcript (checked against OMP 18.11.1). The numbered prompt and its Ctrl-C and Ctrl-D cancel were exercised in a real pty.
- Known limits: a switch needs the coordinator process stopped first; employees already running keep their launch profile until relaunched; the new profile must resolve every bound model role.

## [7.3.0] - 2026-10-17

### Added

- Startup OMP employees launch on the OMP model role bound to their Startup role: architect `plan`, dev `slow`, QA `advisor`, DevOps `slow`, PA `smol`. The binding is one table in `extensions/startup/src/model-roles.ts`; retune a model in the OMP profile's `modelRoles`.
- Manager boot checks that the profile resolves every bound role through `ctx.models` and blocks with the missing roles named. There is no fallback to `default`. An already-admitted manager is not re-checked.

### Verification

- 498 tests, 2501 assertions, and TypeScript checking pass.
- Upgrade note: a profile that sets only `modelRoles.default` (such as `startup-v7`) now blocks manager boot until `plan` and `advisor` are assigned.

## [7.2.0] - 2026-10-16

### Added

- Startup V7 runs on Claude Code (2.1.302+) as well as OMP. One Startup uses one harness, fixed by the manager's first boot. `bun extensions/startup/install.ts install-claude` checks Herdr's managed Claude integration and the linked Startup skills, then writes the `startup-claude` launcher with an ownership receipt; `uninstall-claude` removes both only while their bytes match the receipt.
- `startup-claude` resumes or starts the manager session. Employees start in Herdr panes with their `launchId` as `--session-id`, the role/loop source as `--append-system-prompt-file`, and shared hook settings and MCP config. The `claude-bridge.ts` MCP server `startup` runs the unchanged employee bridge and exposes the `startup_*` tools.
- UserPromptSubmit, PostToolUse and Stop hooks drive `begin_turn` and stop continuation; a fail-closed PreToolUse command hook guards every tool. `asyncRewake` waiters wake idle employees without typing into the composer. A transcript ledger detects turn ends and receipts human pane input, including images. First boot writes a managed root `CLAUDE.md` block that imports `AGENTS.md`.

### Fixed

- Non-architect `crew-ready` notices carry no work and settle complete for every result kind, including question and reconciled uncertain results. They no longer block the member's later item assignment. Unresolved-work conflicts name the blocking assignment, its state and its recovery step.
- `startup_delegate` and `startup_activate` return their durable receipt before pane launches. Launches continue serially in the coordinator; a failure is saved as `layout-uncertain`/`launch-uncertain`/`launch-interrupted` manager alerts naming unlaunched members, a retry while launching is refused, and runtime shutdown waits for launches.

### Verification

- 488 tests, 2473 assertions, and TypeScript checking pass.
- Live Claude Code acceptance in an isolated Herdr session: item `readme-hello-line` reached DONE at revision 7, delegate replied in 68 ms, 22/22 claims settled, and all slots were released.
- Known limits: live state injected as `additionalContext` is persisted in the transcript, not ephemeral; a Herdr session restore resumes bare `claude` without the bridge, so the employee is never re-admitted; `STARTUP_EXECUTION_LIMIT` is required.
- Restart the coordinator to load the fixes. Existing OMP `staff.sqlite` state stays in place; no migration and no replay.

## [7.1.0] - 2026-10-16

### Added

- The Startup coordinator socket exposes a host integration for Ronin. `GET /status` is a bounded read-only picture of binding, store revision, setup receipts, queue rows and their receipts, crews, staff, PA supervision, and unclassified input. It does not record input, route, claim, renew the owner lease, replay intents, recover, or dispatch.
- `POST /host/admit` records one external input with an explicit `general`, `startup`, or `startup_outcome` mode. An identical `requestId` returns the original receipt. A changed payload under that id is HTTP 409.
- `POST /host/cancel` and `GET /host/receipt/:id` cancel one request or one queue item and return a durable receipt. Item cancel settles only that item's saved worker generations and does not stop the shared manager root. Socket mode `0600` remains the only authentication.

### Verification

- 350 tests, 2015 assertions, and TypeScript checking pass. New socket tests use real SQLite and an owned Unix socket. They show `/status` leaving the audit revision, lease expiry, and input history unchanged, and they show admit retries returning the original receipt or HTTP 409.
- Restart the coordinator to load the new routes. Existing `staff.sqlite` state stays in place; no migration and no replay.

## [7.0.18] - 2026-10-16

### Fixed

- Native inbox projection names the exact next prioritized message and `startup_claim {}` command. Opaque ID lists no longer leave the manager to infer whether older administration must be traversed. The selection receipt clears while a claim is outstanding; no copied message ID argument is required.

### Verification

- Regression fails before the receipt exists and verifies that the next actual claim matches its projected message. 346tests/1967assertions and TypeScript checking pass. Native client code is unchanged; the coordinator requires restart with state preserved.

## [7.0.17] - 2026-10-16

### Fixed

- Direct employee-pane input observations remain manager oversight mail after crew technical reports. They no longer preempt new proof/gate results or restore an administrative head-of-line bottleneck. Current failures and crew questions retain first priority; all notice IDs, payloads and stable order are preserved.

### Verification

- Live7.0.16 acceptance exposed a fresh gate behind retained pane notices. The regression fails before the fix and verifies projection, claim ordering and retained notice delivery afterward. 345 tests,1963assertions and TypeScript checking pass. Native client code is unchanged.
- Coordinator restart required; preserve crews/native roots/history and drain live claims before cutover. No automatic replay or bulk acknowledgement.

## [7.0.16] - 2026-10-16

### Fixed

- Manager claims, projections and native wakes share one actionable delivery order. Current failures/questions and crew technical reports bypass stale administrative mail; other employees retain FIFO ordering.
- Routine PA reports and lifecycle observations remain durable TO manager, with latest PA summary/deferred count projected, without forcing manager inference or historical acknowledgement loops.
- Presence, item, input and settlement alerts are deferred only when current state proves recovery or supersession. Fresh control polling cannot hide missing Herdr presence; unknown alerts remain actionable.
- Claim selection reads only its own pending inbox and unresolved claims. All deferred IDs, payloads, pending records and existing claims are retained.

### Verification

- Regressions reproduce technical-report starvation, admin-only wakes, legacy continuation loops and mistaken presence recovery. 344 tests, 1959 assertions, TypeScript checking and twelve installed-OMP offline guard checks pass. 120 routine PA reports retain history with zero manager inference eligibility.
- Coordinator restart required; preserve native identities/history and explicitly reconcile interrupted claims. No automatic replay or bulk acknowledgement.

## [7.0.15] - 2026-10-16

### Fixed

- Item execution delivers the current assignment directive and owning architect destination alongside the original intake snapshot. Authorized implementation rework is no longer lost behind an earlier review-only procedure.
- Dev item settlement atomically saves a linked result report to its architect, including completed, question and uncertain outcomes. Identical settlement replay reuses the report.
- Completed dev assignments retain an indexed, own-item review continuation with the exact result ID and current revision. Explicit blocks clear it; QA, architecture and landing gates remain explicit.

### Verification

- Regressions reproduce dropped string/object directives, missing result handoffs and lost review continuation before the fixes. 333 tests, 1686 assertions, TypeScript checking and twelve installed-OMP offline guard checks pass.
- Coordinator/store update requires a coordinator restart. Preserve identities/history and reconcile interrupted claims explicitly; no claim or uncertain operation is replayed automatically.

## [7.0.14] - 2026-10-16

### Fixed

- Context-only OMP continuations consume their queued wake, allowing later PA duties and new crew messages to wake the same resident employee. Wake admission remains coalesced while context is refreshed.
- Unchanged inbox suppression and provider-error pauses remain enforced; no coordinator/store or protocol change.

### Verification

- Regression fails on the second scheduled duty before the fix and passes across five context-only duties afterward. 327 tests, 1663 assertions and TypeScript checking pass; twelve installed-OMP offline guard checks pass.

## [7.0.13] - 2026-10-16

### Fixed

- Unchanged durable messages no longer generate another inference wake every 30 seconds. New messages coalesce behind one scheduled native wake.
- Provider failures pause automatic inference while authenticated polling continues. The pause survives same-transcript reattachment and requires explicit interactive/RPC input to resume; automatic cues and connection recovery cannot clear it.
- Repeated unchanged HTTP400/403/409 command failures, including unresolved claims, are suppressed locally and abort the native turn. Corrected commands, changed claim state and fresh authentication permit recovery. Capacity admission/release and service failures remain retryable.
- Coordinator/store source and protocol remain unchanged; preserve the existing coordinator and refresh clients to retain active claims and crew state.

### Verification

- Regressions reproduced before the fix; 326 tests, 1653 assertions, TypeScript checking and six probe-driver tests pass.
- Twelve installed OMP offline-provider checks pass. After one simulated provider failure, 100 new inbox states and a queued retry produce zero additional provider calls. No paid verification calls, budget changes or credential changes.
- Request suppression is proven; post-fix billing savings and live provider-cache percentages remain unmeasured. See docs/startup-v7/cost-control-acceptance.json.

## [7.0.12] - 2026-10-16

### Fixed

- Verified canonical role/loop instructions remain stable in the native system prompt. Changing checkpoint, claim and team state is appended after conversation history as ephemeral user-role data, preserving the existing prompt prefix and opening-message routing affinity.
- Live state no longer changes the system prompt or prepends a developer message on every model call. It does not accumulate in native history. Existing root/helper authority and admission guards remain enforced.
- Client-only fix: coordinator/store code and business state are unchanged. Resume existing native clients to load the new prompt layout.

### Verification

- Regression reproduced before the fix; 318 tests, 1603 assertions, TypeScript checking and six probe-driver tests pass.
- Eleven installed OMP18.11.1 offline-provider guard checks pass, including real native prompt-prefix stability across a state-changing tool call. No paid provider calls were used for this proof. Actual cache-hit percentages remain unmeasured while Aspen's OpenRouter key is budget-blocked.
- Source-backed token-volume investigation: docs/startup-v7/cache-and-volume.md.

## [7.0.11] - 2026-10-16

### Fixed

- Aggregate inbox wakes start only while the native session is idle. Busy sessions receive no extra queued inference turns, and idle sessions can recover already queued messages instead of waiting indefinitely behind them. This corrects the PA duty edge case reproduced during sustained live acceptance of 7.0.10.
- Coordinator and store modules are identical to 7.0.10; client refresh does not require restarting the coordinator or fencing active crew work.

### Verification

- 317 tests, 1587 assertions, TypeScript checking, six probe-driver tests and eight compiled-OMP guard checks passed. The additional regression fails on 7.0.10 and covers both busy-turn suppression and idle pending-message recovery.
- Live recovery, reconciliation, native PA duty checks and crew progress evidence: docs/startup-v7/aspen-manager-recovery-acceptance.json.

## [7.0.10] - 2026-10-16

### Fixed

- Native inbox polling sends one aggregate wake instead of one wake per durable message, and waits behind an already queued native message. This prevents a recovered manager's retained backlog from flooding its model context while preserving every individual inbox record.
- Includes the manager reconnection, lifecycle alert compaction, connectivity health and finished-crew retirement fixes from 7.0.9. The additional wake amplification was reproduced during live Aspen acceptance.

### Verification

- 316 tests, 1584 assertions, TypeScript checking, six probe-driver tests and eight compiled-OMP guard checks passed. The new regression proves 1,000 messages produce one wake and a later message waits behind a queued wake.
- Live Aspen recovery, reconciliation, progress and cleanup evidence: docs/startup-v7/aspen-manager-recovery-acceptance.json.

## [7.0.9] - 2026-10-16

### Fixed

- Resuming the original manager transcript automatically restores admission using its saved private configuration, pane and named profile. Failed admission blocks technical tools and retries in the same pane. Foreign roots cannot inherit the manager binding.
- Health now exposes authenticated manager connectivity and degrades when its polls go stale while keeping coordinator admission available for recovery.
- Sequence-only Herdr updates and idle/done display alternation no longer generate repeated completion alerts. Superseded pending lifecycle alerts are acknowledged with durable receipts; their original payloads, audit history, claimed mail and technical reports remain intact.
- Idle staff from finished crews can retire through the existing guarded command. Manager, PA, active crews and unresolved work remain protected.

### Verification

- 315 tests, 1580 assertions, TypeScript checking, six probe-driver tests and eight compiled-OMP guard checks passed. Regression tests first reproduced manager admission loss, repeated lifecycle alerts, backlog compaction, stale manager health and finished-crew retirement.
- Aspen installation and bounded live recovery/progress evidence are recorded in docs/startup-v7/aspen-manager-recovery-acceptance.json after deployment.

## [7.0.8] - 2026-10-15

### Fixed

- A parked no-claim settlement rejection now clears when genuinely new ready inbox work arrives, so the next scheduled PA duty can wake its resident employee. With an outstanding claim, unrelated mail leaves that claim's retry guard intact. This corrects an edge case found during final 7.0.7 acceptance.
- Native client modules are unchanged from 7.0.7; the coordinator supplies the additional recovery state through the existing compatible projection field.

### Verification

- 309 tests, 1531 assertions and TypeScript checking passed. The 7.0.7 client modules also pass six driver tests, eight compiled-OMP guard checks and a compiled-OMP settlement proof: two model attempts, one rejected HTTP write, native duplicate abort and no subsequent file/shell writes. The client source hashes remain identical in this release.

## [7.0.7] - 2026-10-15

### Fixed

- Native startup_settle accepts result only. The authenticated store selects the employee's current claim atomically; agents no longer copy claim UUIDs. Exact saved-result replay runs before current-claim selection, preserving a later active claim after response loss or retries.
- Keep existing explicit settlement wire requests compatible, including claimId="current" for running legacy clients. Incorrect explicit IDs are rejected rather than silently retargeted. Canonical role/loop hashes remain unchanged for live crews.
- Distinguish missing claims, foreign ownership, stale generations, reconciliation, already-settled claims, ambiguous claims and result-ID conflicts. HTTP errors include machine-readable recovery code, nonretryable status and corrective action; a deduplicated durable alert goes TO manager.
- Suppress repeated deterministic settlement failures locally, including retries that merely regenerate a result ID. Duplicate native attempts abort and park instead of looping through stop hooks or cue wakeups. Polling continues; corrected requests and authoritative claim-state recovery remain possible. Historical receipt replay cannot release another claim's guard, while genuine result-ID collisions can be corrected.

### Verification

- 308 tests, 1525 assertions, TypeScript checking, six driver tests and eight installed-OMP guard checks passed. Regression tests reproduce the mistyped-ID retry, result replay after a new claim, ownership/generation/reconciliation failures, duplicate native abort, continued polling and corrected recovery.

## [7.0.6] - 2026-10-15

### Fixed

- Poll only an employee's pending messages, unresolved claims and reconciliation grants through SQLite expression indexes. Select its runtime directly; manager/PA polling and supervision no longer parse completed global history. Existing records and audit history remain intact; indexes are built on upgrade.
- Root capacity admission/release bypass semantic history comparison. A release retry storm after reconnection can no longer monopolize the coordinator with full-history encoding.
- Connection errors identify the Unix socket, endpoint, underlying error/cause codes, elapsed time and deadline, with credential redaction and structured logs. Changing elapsed time does not create duplicate outage notices.
- Emit one visible recovery notice after authenticated polling resumes. Wake an idle root with outstanding work so a recovered connection does not leave its claim parked; clean idle recovery stays quiet.
- Native guard proof now joins its fixture helper before closing the bridge, preventing an asynchronous completion from racing test teardown.

### Verification

- 290 tests, 1455 assertions, TypeScript checking, six driver tests and eight installed-OMP guard checks passed.
- Aspen sustained load passed for ten minutes: 11,984 health requests, all HTTP 200, p99 117.6ms, maximum 953.41ms, average coordinator CPU 23.95% and ten additional settled PA checks. Native transport recovery produced one detailed error and one restoration notice with unchanged panes, transcripts and process identities. Evidence is recorded in the Startup V7 acceptance report. Crew processes, identities, transcripts, launch files and queue contents are preserved during the coordinator update; interrupted claims remain available for explicit reconciliation.

## [7.0.5] - 2026-10-15

### Fixed

- A failed Herdr observation read means unknown manager presence when its control connection remains fresh. Do not fabricate manager-offline duties that fill the PA inbox and delay its scheduled checks.
- Includes all supervision isolation, queue preservation, health reporting, polling and admission-replay fixes from 7.0.3 and 7.0.4.

### Verification

- 281 tests, 1414 assertions and TypeScript checking passed, with six driver tests and eight installed-OMP guard checks also verified for this patch series.
- A separate native Startup on Aspen exercises the production runtime factory with real OMP manager/PA sessions, real-time 60-second checks and controlled read failures. The live Startup is monitored independently; its queue and Herdr observations are not modified for fault injection. See the Aspen acceptance evidence for phase results and deployment preservation checks.

## [7.0.4] - 2026-10-15

### Fixed

- Native re-admission re-reads the current launch after its asynchronous Herdr lookup so it cannot overwrite observations committed while that lookup was pending. Runtime updates reject lifecycle checkpoint regression.
- Historical observation alerts replay against their stable launch/employee/generation/state/sequence identity while retaining their original timestamp, payload and acknowledgement. This repairs a legacy stale checkpoint without rewriting immutable alerts; conflicting identities remain errors.
- Includes the supervision isolation, PA continuity, health reporting, queue-format preservation and polling improvements from 7.0.3.

### Verification

- 280 tests, 1411 assertions, TypeScript checking and six driver tests passed. Additional cases cover concurrent observation/admission, historical alert replay, checkpoint regression and conflicting alert identity. Installed-OMP guard checks also passed for the unchanged employee bridge.

## [7.0.3] - 2026-10-15

### Fixed

- Herdr's seen/unseen completion display can alternate between `done` and `idle` without advancing its lifecycle sequence. Accept those display changes without duplicate alerts or semantic progress; conflicting activity states and regressed sequences remain errors.
- Isolate observation collection, individual observation and canonical queue read errors. Failed reads produce durable manager diagnostics while other observations, PA checks and independent deadline checks continue.
- Report degraded/stale supervision through HTTP 503 and completion/success timestamps. Keep the production timer running through failures and recover HTTP 200 after a successful cycle.
- Read and write array, `items` and `rows` queue containers without dropping metadata or rewriting their shape. Reject ambiguous dual-key documents explicitly.
- Employee control polls avoid unrelated global history, and supervision no longer repeatedly loads the same history per employee or queue item.

### Verification

- 276 tests, 1403 assertions, TypeScript checking, six driver tests and eight installed-OMP native guard checks passed. A production-timer integration test settled two PA checks during queue read failures and observed health recover without a restart.

## [7.0.2] - 2026-10-15

### Fixed

- Missing optional Herdr environment variables no longer produce rootless Zod boot errors. Manager context is resolved through the Herdr CLI, including the default server; employees no longer require unused workspace/session variables. Missing employee profile variables use the saved launch profile, and missing manager profile variables select OMP's native default profile.
- Native boot hooks contain errors and leave existing panes recoverable. Failed employee admission retries every five seconds in the same pane; `/startup-retry` retries immediately. Closed bridges stop handling events so recovery does not retain stale tool blockers or duplicate turn requests.
- Authenticated boot failure reports retain the launch, redact its credential and send a durable manager alert immediately. Interactive Herdr readiness cannot conceal a failure already reported during launch. Abandoned/superseded credentials remain fenced, and delayed failure reports cannot downgrade an admitted runtime.
- CLI failures include command, exit status and response details. Coordinator/reporting outages remain visible and can recover without spawning duplicate panes or replaying work.

### Verification

- 266 tests, 1360 assertions, TypeScript checking, six driver tests and eight installed-OMP native guard checks passed. Live read-only Herdr checks confirmed current-pane discovery and default-session selection; the reported Linux session was not retested.

## [7.0.1] - 2026-10-15

### Fixed

- Startup tries installed OMP and Herdr binaries first. Release numbers, including newer major versions, are compatibility hints rather than startup blockers or reasons to create an isolated installation.
- Removed the OMP 18.8.9 pin, Herdr 0.9.5 minimum, protocol/schema-number pins and integration-v10 pin. Admission still checks native root hooks, transcripts, managed integration identity, reported Herdr compatibility and required API capabilities.
- Installer and native guard probes identify OMP without pinning its release. The probe records the actual executable version and judges behavioral checks.
- Regression coverage includes OMP 18.10.4 and newer majors, capable Herdr 0.9.4 and newer majors, compatible protocol metadata changes and integration revisions around v10. Missing capabilities remain actionable errors.

### Verification

- 254 tests, 1316 assertions, TypeScript checking, six driver tests and eight installed-OMP native guard checks passed.

## [7.0.0] - 2026-10-15

Startup V7 requires Herdr and OMP and runs complete hierarchical crews as independent, directly interactive native sessions.

### Breaking changes

- Startup requires Bun, OMP 18.8.9, Herdr >=0.9.5 with protocol 22, the managed OMP integration v10 and an explicitly selected named OMP profile. Native task-only staffing is no longer the Startup runtime.
- V7 supports new V7 state. Existing V6 database ownership and configured duties are refused. V6 migration and filesystem duty/repair parity are not implemented; preserve existing staff, queue and history.
- Startup's package entry is `extensions/startup/v7.ts`. The retained V6 entry and probes are historical/component evidence, not a V7 fallback.

### Added

- One detached coordinator owns durable staffing, immutable event crews, authenticated root admission and supervision independently of manager inference.
- Each crew has an owning architect, independent QA and one or more developers, with one real OMP pane per employee and one Herdr tab per crew. The manager and mandatory permanent PA have separate panes.
- Periodic PA checks produce scoped reports to manager. Missing/offline/overdue PA supervision blocks new delegation and landing while preserving existing work and history.
- Semantic progress deadlines, durable idle/done observations to manager, explicit blockers, generation/epoch fencing and evidence-based recovery prevent silent stale-state acceptance. Heartbeats and working animation do not count as progress.
- Live acceptance records two complete crews across eight native roots, both documentation items canonically DONE, 35 PA reports, real five-minute architect-stall detection and 30-second PA presence detection, followed by same-identity recovery. [Proof and limits](docs/startup-v7/acceptance.md).

### Fixed

- Native extension registration timing, generated worker imports and transitional Herdr session/readiness fields no longer prevent employee spawning/admission.
- Native XD tool dispatch preserves employee authority. Herdr's server-wide sequence jumps and working states no longer flood the manager with false gap/lifecycle alerts.
- Idle recap/auxiliary requests and reattached roots release execution reservations instead of starving other crews.
- Explicit claim reconciliation restores crew inbox delivery after all uncertain member claims/grants are resolved. Exact retries preserve evidence and completed assignments.
- Explicit manager selection checks/restarts a provably dead coordinator before polling its existing client.

### Verification and limits

- 242 tests, 1279 assertions, TypeScript checking, six driver tests, eight compiled OMP guard checks and 18 computed live checks passed.
- Native automatic restore and automatic OS restart after coordinator death/host reboot remain unverified/unsupported. Manual resumes must preserve the profile, cwd, integration, employee bootstrap and original native transcript.
- Shipping restrictions follow explicit user instructions. Canonical QA, architect gate and manager completion records retain their role checks; repository credential isolation is not required.

## [6.0.0] - 2026-10-14

Startup V6 adds durable staff, architect-led teams and native OMP inbox/loop support. Machine-specific companion installation remains an explicit separate action.

### Breaking changes

- The manager handles high-level routing, decisions, staffing, authorization and final landing. It delegates technical intake and implementation to an architect-led team instead of performing intake itself.
- Each distinct intake receives a fresh complete team: exactly one architect, one QA and one or more developers. The architect leads the team and reports to the manager; team members report through their architect. Replaying the same intake event retains its team and requested developer count.
- Runtime persistence requires the Startup companion on the supported Oh My Pi 18.8.9 interface. Installing or linking skills alone does not install the companion or provide native persistence.

### Added

- `hire` supports user- or manager-directed additive staffing. `hire devops 6` adds six more DevOps employees; retrying the same saved request adds none, while a deliberate later hire uses a new request ID. Idle staff can join a fresh team generation; busy teams remain independent.
- `startup-loop` defines the shared employee wake, inbox, claim, result, question and waiting procedure. Durable employee identities, mail, assignments and duty history survive individual native turns and queue drain; waiting does not retire staff.
- A transactional SQLite store outside the bound project retains staffing, team membership, received inputs, inbox claims, immutable results, ownership leases, generations and resource grants. Current-root and source checks reject stale or foreign callers.
- Human inputs are captured before model lookup and routed explicitly. Successive requests, multiple intents, clarifications and missing details remain durable. Scoped text pages and native image retrieval retain the full request without flooding routine context with historical inputs.
- Native `/startup new`, `/startup select` and status commands establish the bound manager. Boot synchronously creates or updates `AGENTS.md` beside `.startup/` before asynchronous dispatch, preserving unrelated existing bytes and rejecting malformed or foreign managed guidance.
- Public manager tools expose staffing, readiness, real capacity blockers and bounded recovery pages containing unresolved claim, grant, assignment and pending-message IDs. Recovery does not require private database inspection.
- Assigned DevOps duties support periodic local JSON observations, explicit acceptance conditions and separately authorized JSON replacement with post-action verification. Same-target grants serialize admitted repairs; uncertain actions require reconciliation rather than automatic replay.
- Named-profile companion install/uninstall checks ownership, preserves pre-existing configuration and restores only owned changes. [Installation and runtime documentation](extensions/startup/README.md) covers dependencies, boot, tools and recovery.

### Changed

- Independent ready teams dispatch immediately while other intake, implementation or clarification is pending. Before waiting or ending a turn, the manager must dispatch ready work or retain a concrete dependency, resource or capacity blocker. Missing capacity favors hiring within actual limits.
- Native OMP remains the execution authority for tasks, transcripts, recursion, budgets, disabled agents and capacity. Ordinary native task grammar remains available in batch and single-call modes; Startup also supports synchronous native results without changing host settings.
- `STARTUP_EXECUTION_LIMIT` accepts an explicit positive safe integer. Native capacity further bounds concurrent work, including ordinary buddy/review descendants; no absent-limit default of six is imposed. Roster size and concurrent execution are separate.
- Every employee receives the full canonical role and shared loop sources, with assignment data kept separate. Readiness requires verified native source admission. Safe manager-owned source refresh preserves employment and history while refusing unresolved work.
- Technical employee profiles permit bounded generic `task` children for canonical supervisors and reviewers. Helpers gain no employee identity, inbox or hiring authority; PA child spawning remains disabled.
- Item execution, QA proof, architect approval and manager landing use typed, revision-checked transitions through the existing queue journal. Existing per-kind procedures, review rigor and final evidence requirements remain in force.
- Sprint/retro bookkeeping preserves independent fan-out. DevOps retirement is limited to idle staff after unresolved work, mail, duties and grants are resolved; history is retained.

### Fixed

- Successive intake is no longer lost behind readiness checks or an earlier team's intake. Waiting for a clarification preserves the original assignment and does not silently complete its item.
- Later dispatch refusal or exceptions preserve earlier successful single-call activations. Partial retries retain the original team/employee identities and successful sibling handles.
- Synchronous native result correlation requires verified source binding; job completion alone cannot create readiness. Proven terminal activation and ordinary-helper failures release only their matching execution reservations.
- Profile preparation and reusable-source checks complete before publishing undispatched activation expectations or committing an incompatible team. Failed preparation remains retryable with the same IDs; stale idle sources can be explicitly refreshed.
- Item transitions drain pending journal writes before another revision or retry on the same live connector. Conflicting retries cannot overwrite an immutable pending intent.
- Narrowly scoped host verification reads remain available during recovery, including pending-input reconciliation, while ordinary reads and unrelated paths remain guarded.
- Public failure alerts include the identifiers needed to reconcile interrupted child work. Expected negative-test diagnostics are captured and asserted, keeping successful verification output clear without hiding unexpected failures.

### Upgrade and operating limits

- Existing V5 queue rows, receipts, unknown fields, resource records and unrelated root instructions are preserved. There is no destructive bulk migration or automatic installation into a normal OMP profile.
- Outside OMP, the canonical dispatch prompt supplies the full role/loop procedure and reports once that "Oh My Pi is best-suited for this system." An installed `omp` executable does not select native mode. Known OMP with a missing or failed companion stays blocked until corrected.
- Monitoring runs only while a current owner host is alive. Offline periods produce no observations, and old observations are not current health. The included connector handles bounded regular local JSON files; deployment/service-health integrations are not included.
- Cold recovery resumes the same saved manager transcript, waits the real default 60000 ms owner lease, reconciles uncertainty with fresh verification and explicitly dispatches saved messages. This release does not provide an always-running daemon or automatic takeover from a different transcript.
- Prompt-only mode has no native persistence guarantee. Native deterministic-provider proofs establish runtime mechanics and ordering, not model reasoning quality or completion of an arbitrary application pipeline.

### Verification

- Latest reviewed runtime: 157 passing behavioral tests, 894 assertions, TypeScript checking and six passing Python probe-driver tests. Final independent review's five important findings and one minor diagnostic issue are addressed, with no new findings in scoped rereview.
- Five final-fix installed-OMP artifacts contain 44 passing checks covering single-call activation, synchronous results, preparation/refresh, partial retry and public cold recovery. Sixteen retained baseline artifacts contain 158 historical passing checks, including a separate actual Codex prompt-only fixture; historical evidence is not relabeled as a fresh run.
- [V6 acceptance](extensions/startup/probes/v6-acceptance.md) and its manifest retain exact artifact hashes, source fingerprints, original failure evidence, complete final review reports, controller rulings and reproducible commands. The independent fan-out fixture dispatches a complete AGENTS team while BUILD intake remains held; boot guidance exists before either dispatch.

## [5.0.1] - 2026-10-13

### Fixed

- Intake captures every actionable request before readiness checks, including additional tasks across turns and incomplete requests. Missing details remain visible as `NEEDS_DECISION` queue rows; explicit rejection preserves its reason.
- New rows retain task text, acceptance, blockers, and intake event references. Complete receipts account for every intent; repeated intake preserves existing rows and fields, verifies saved state, and recognizes event retries without duplicating work. Clarifications to undispatched items retain their IDs.
- Intake, status, retro, and standing-rule updates use the manager's selected Startup namespace. Legacy root queues are surfaced for recovery with ownership and ID conflict checks.
- Manager dispatch uses the durable task payload and only ready rows; PA and status expose unfinished intake receipts. Existing rows remain compatible without a bulk rewrite.

## [5.0.0] - 2026-10-13

### Breaking

- `startup` v5 requires canonical role binding for the manager and every specialist dispatch. Native role or skill preloading is preferred; when unavailable, the full canonical role skill is passed verbatim in the child instruction block, separate from assignment data. A missing or unbindable role blocks dispatch instead of falling back to a manager-authored persona prompt.
- `startup-intake` adds `requested_roles` to new queue rows. Old rows without the field mean no explicit role requests; no bulk migration is required. Explicit user-requested roles must be dispatched and their binding and result recorded in the ledger.

### Changed

- `startup` runs intake in the manager context. Explicit DevOps coordination is a mandatory role dispatch before worker fan-out and does not authorize provisioning. DevOps returns `READY`, `NEEDS_INPUT`, or `NO_ACTION`.
- `startup` and its README role index now describe architect as the required merge gate and align QA and DevOps triggers with their role skills.

## [4.2.0] - 2026-10-12

### Added

- Stacked PRs everywhere CI bottlenecks bite: `startup` chains same-repo/same-target code items as `--base` stacks (flat on any other kind/repo/target, flat fallback with reason on stacking failure), merges bottom-up with `gh pr edit --base` child retarget; `queue.json` rows + outcome blocks carry `base/stack-mode`, `startup status` renders them.
- `dark-factory` gains `STACK_MODE` (`auto` default / `stacked` / `flat`) plus a standing stack driver sub-agent (owns retarget/rebase/re-green traffic from FAN-OUT to EPIC CLOSE, never merges); planner emits stack chains along hard DAG deps, principal merges bottom-up, final report carries per-ticket `stack-mode`.
- Commit-trail discipline in every code prompt: `pipeline` (per wave, per review-round fix batch), `dark-factory` brief, `startup-role-dev`, `hotfix` (per site) — small logical commits with decision/why messages, never one held commit; Step 5 organizes leftovers only.

## [4.1.0] - 2026-10-12

### Added

- Worker outcome gains `coding_mins/waited_mins/evidence`; manager stamps `dispatched_at`/`outcome_at`/park intervals, sanity-checks only.
- Per-item `completions/<id>.md` with `OVERSIZE` flag over 60 coding minutes; retro scans and owns cleanup.
- `startup new <name>` binds a folder; `.startup/config.md` identity, `.startup/<repo>/<role>.md` overrides inlined into assignments; `stop-doing` routes scoped rules there.

## [4.0.0] - 2026-10-12

### Breaking

- `startup` family goes generic (kind system v2): workers are parameter vessels executing manager-assigned `{kind, procedure, convention-source, acceptance}` for `code | research | docs | ops` — code keeps full `pipeline`, research yields cited synthesis memos (`memo:` handle, no merge), docs writes against the named convention source, ops follows the `server-maintenance` pattern. Every worker pairs with a manager-spawned adversarial buddy (verdict to manager only; width counts pairs). Architect flips advisory → merge-gate: no item closes without `APPROVE | REDO:<file-bounded scope>`; scopeless veto rejected. QA generalizes per-kind proof (Playwright + Storybook stay code-only); DevOps provisions per-kind resources (worktrees code/docs, live-target locks ops, none research). `startup-intake` assigns kind with inference rule; `startup` routes by kind.

## [3.3.0] - 2026-10-12

### Added

- `startup` skill family (12 dirs): persistent cross-turn queue (`<home>/startup/queue.json`, never `tmp/`), singular manager as sole boss contact, full `pipeline` per item with manager-owned merges, standing architect/QA (Playwright + Storybook mandate)/DevOps/PA-loop roles, `startup-intake` repeatable criteria, internal `startup-sprint` + `startup-retro` count-based retro with 64KB memory compress, `startup-stop-doing` text/screenshot rule injection, `startup-status` queue/bulletin view. Zero live agents on drain; next invoke reloads.


## [3.2.0] - 2026-10-07

### Changed

- `hotfix` gains Step 8 FINAL: after REVIEW+VERIFY (pr-review-toolkit light verdict) and SIMPLIFY (code-simplifier pass), the completed fix is presented with verdict + simplify + diff + PR body and waits for a one-word go before SHIP. SHIP renumbered to Step 9 and runs only on go; sequence is now INTAKE -> CONFIRM -> SPREAD -> PLAN -> FIX -> REVIEW+VERIFY -> SIMPLIFY -> FINAL -> SHIP.

## [3.1.0] - 2026-10-07

### Added

- `code-simplifier` skill: final behavior-preserving polish pass over a scoped diff — standards derived from repo guides, lint config, nearest neighbors, and discipline skills (no hard-coded style); every candidate carries an equivalence claim; file-disjoint apply, one edit per candidate; caller's gate re-verifies and red reverts the candidate (never fix forward); no review round; `SIMPLIFY RESULT` block. Adapted from `anthropics/claude-plugins-official` `plugins/code-simplifier/agents/code-simplifier.md` (Apache-2.0 © Anthropic); upstream's project-specific JS/React rules and "proactive, unrequested" activation dropped in favor of caller-invoked scope.

### Changed

- `pipeline` Step 7 invokes `code-simplifier` over the whole PR diff with the recorded `verify-mode` as its gate.
- `hotfix` gains Step 7 SIMPLIFY (approved-scope diff, Step 6 scoped gate, no re-review); SHIP renumbered to Step 8.
- `pr-review-toolkit` Simplify Pass section retired; polish routes to `code-simplifier`.

## [3.0.1] - 2026-10-05

### Fixed

- `hotfix` overview phase list folded to `REVIEW+VERIFY` to match the Step 6 heading; 7-step numbering unchanged.
- `dark-factory` outcome schema carries the last-round review `verdict` (`APPROVE | FIX-THEN-SHIP-at-cap + must-fix open | BLOCK`); DONE requires APPROVE, at-cap must-fix parks as stop-and-report, BLOCK parks as BLOCKED. COLLECT, FAN-OUT, and sub-orchestrator brief enforce it.
## [3.0.0] - 2026-10-05

### Breaking

- `pr-review-toolkit` rebuilt as the canonical outcome-driven adversarial review: five angles (spec, breaker, failure, proof, shape) propose in parallel, Level/Splinter club fights max 2 debate rounds, every run ends in a `REVIEW VERDICT` block (`APPROVE | FIX-THEN-SHIP | BLOCK`) with proven must-fix items (file + proof + impact + fix), dissent log, and residual risk. Six-lens Critical/Important/Suggestions taxonomy retired; simplify is a verdict-free polish pass.
- `pipeline` Step 6 enforces verdicts (BLOCK escalates, must-fix always fixed, APPROVE still runs min 3 rounds), Step 7 runs the simplify pass only, merge/final-report track verdict + must-fix + dissent.
- `hotfix` gains REVIEW in its sequence: light variant (single sweep + combined challenge, no defense round) before VERIFY; BLOCK hands to `pipeline`, never to SHIP. VERIFY renumbered content unchanged.
- `dark-factory` routes review canonically through `pipeline` verdicts; principal never invokes the fight, verifies via outcome blocks. `architect` Phase C uses the fight protocol against the sketch.
## [2.3.0] - 2026-10-04

### Added

- `architect` skill (+ `references/`): design-before-implement — Ground (traced model), Sketch (≥2 parallel candidates, red-flag screen, synthesis), Agree (opt-in checkpoint), Implement-against-sketch, Scrap-on-friction. Cross-references `topic-research`, `code-quality-audit`, `architecture-audit`, `pr-review-toolkit`. Adapted from `cursor/plugins` `pstack/skills/architect` (MIT © 2026 Lauren Tan); Cursor-only deps replaced with repo-native `task` subagents and inline principles.
- `correct` skill: make repeated operator corrections impossible — find mistake classes (count at 2), fix at the highest level (architecture > types > lint > test, docs last), one commit per class, prove each check fails on a real past mistake. Adapted from `cursor/plugins` `pstack/skills/correct` (MIT © 2026 Lauren Tan).
- `typescript-best-practices` skill (+ `references/patterns.md`): 16-rule editing discipline for `.ts`/`.tsx` — discriminated unions, branded types, constructive modeling, `unknown`-over-`any`, schemas-before-guards, no-`as`, narrowing hierarchy, exhaustiveness, `satisfies`-over-`as`, boundary validation. Adapted from `cursor/plugins` `pstack/skills/typescript-best-practices` (MIT © 2026 Lauren Tan); Cursor `paths`/`disable-model-invocation` frontmatter dropped per repo convention.

 ## [2.1.0] - 2026-10-03

### Added

- `smoke-test` skill: post-deploy verification of a live app — DISCOVER routes from working-directory source (user confirms scope), HTTP SWEEP over all routes (dead pages FAIL fast), BROWSER pass on survivors (render, console errors, same-origin network, read-only interactions), per-page checklist with PASS / PASS WITH GAPS / FAIL verdict. Strictly non-mutating with session-only auth hygiene (`provided (redacted)`); auth-gated pages without creds report `SKIPPED (no auth)`, never PASS.

## [2.0.0] - 2026-10-03

### Breaking

- Skills live under `skills/<name>/SKILL.md`; `shared/cleanup.md` archived as pointer to terminal `skills/cleanup/SKILL.md` (no self-tail). Upgrade via `upgrading-jp-skills` v2 block: pull, drop stale root symlinks, relink from `skills/*/SKILL.md` across all five registries.
- Unified `code-quality-audit` replaces `nextjs-`, `elysia-`, `vite-tauri-code-quality-audit` (deleted): stack scout (stack + gui + dominant libs + mixed-slice rule) → 4-way focus intake (weighting, not subset) → six composition-biased lenses → merge → prioritize/stop.
- `architecture-audit` keeps 5 lenses + consensus; prompts gain functional-unit bias (stateless inner + stateful wrapper, hooks behind provider/adapter, route → service).

## [1.4.0] - 2026-10-02

### Added

- `server-maintenance` operations log: completed operations (config edits, installs, service changes, deploys, reboots, user/cron/firewall/network changes, restores/migrations) append one compact entry (symptom / change / verify) to `<home>/servers/<slug>.ops.md` via a mandatory RECORD step before the cleanup tail. Read-only checks record nothing; connection record and legacy fallback unchanged.

## [1.3.0] - 2026-10-02

### Changed

- `hotfix` now ships a ready PR: scoped commit on the current branch (approved-scope `git add` only), push, `gh pr create` ready never `--draft` (`gh pr ready` repair), stop-and-report on the target branch; VERIFY reuses Step 1 intake creds for auth checks (ask only when missing/expired/lacking scope, session-only hygiene, never in PR body).
- `pipeline` Step 5 opens ready PRs (`gh pr ready` repair); activation line ships in the same turn as the first Step 1 action with a ~2 min stall rule (emit intake block, continue).
- `dark-factory` outcomes require ready PR URLs (draft is a protocol violation); `AUTO_MERGE` merge decision unchanged.

## [1.2.0] - 2026-09-29

### Added

- `hotfix` skill: in-place bug fixes on the current branch — opt-in live repro with session-only creds (`provided (redacted)`), conditional 1→3 issue-spread analysis, dead-simple 5-line plan gate, single-implementer fix, repro + touched-file verification. Working tree only; never commits, pushes, worktrees, or merges.

## [1.1.0] - 2026-09-29

### Changed

- `pipeline` worktrees now live under the canonical home at `<home>/worktrees/<repo>/<branch>` (`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`), grouped by repo for tracking. Repo recipes that accept a target path get the derived path; recipes with hard-coded locations are bypassed for a bare `git worktree add` at the derived path unless they cannot work elsewhere.
- `dark-factory` `WORKTREE_MODE=local` follows the same `pipeline` Step 1b contract; fan-out and cleanup reference `<home>/worktrees/<repo>/<branch>`, orchestrator checkout untouched.
- Stable home layout gains `worktrees/<repo>/<branch>/`; `upgrading-jp-skills` ensures `worktrees/` exists alongside `servers/` and `tmp/`.
- Harness registries cover five targets (adds Pi, Oh My Pi); `omp` restart noted after (re)linking.

## [1.0.0] - 2026-09-29

### Breaking

- Repo themed as jp-skills; README grouped by category (Orchestration, Research, Audits & review, Operations).
- Stable home introduced under XDG (`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`) with `config.json`, `servers/`, `tmp/`. server-maintenance records moved from `~/.local/share/server-maintenance/servers/`; the upgrade skill migrates them automatically.
- Every skill ends with a Framework tail pointing at `shared/cleanup.md` (scratch hygiene, record persistence).

### Added

- `VERSION` file as version truth; this changelog.
- `upgrading-jp-skills` skill: resolves the cached clone, `git pull --ff-only`, migrates legacy records, relinks all three harness registries, stamps the installed version.
