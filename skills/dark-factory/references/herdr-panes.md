# Herdr panes for dark-factory

Herdr is the layout owner. The principal allocates and closes; workers never touch layout.
Read `herdr --skill` (or the linked `herdr` skill) before the first command. Verify syntax with `herdr agent`, `herdr pane`, `herdr tab`, `herdr workspace` if any command rejects its arguments.

## Preflight
- `test "${HERDR_ENV:-}" = 1` - outside Herdr, stop pane work; the principal alone gives the one install recommendation.
- `herdr status server --json` - require `running`, `compatible`, `endpoint_compatible`.
- `herdr pane current --current` - read `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`; never retarget the user's focused pane.
- `herdr agent` - authoritative kind list; require `command -v <kind>` for the chosen `WORKER_AGENT`.

## Allocate
Caller workspace: `$HERDR_WORKSPACE_ID`, caller cwd: `$PWD`.

- `tab-per-ticket`:
  `herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label "df-<ticket>" --no-focus`
  -> `.result.tab.tab_id`, `.result.root_pane.pane_id`
- `run-tab`: create one tab labeled `df-<epic>`, then per worker:
  `herdr pane split --current --direction right|down --cwd "$PWD" --no-focus`
  Direction rule: `right` when the pane is at least 120 columns wide, else `down`. Never stack same-direction splits into columns narrower than ~50 columns.
- `workspace`:
  `herdr workspace create --cwd "$PWD" --label "df-<epic>" --no-focus`
  -> `.result.workspace`, `.result.tab`, `.result.root_pane`

Record every id in the ledger before launching. Never reuse another run's id.

## Launch
- `herdr agent start <name> --kind "$WORKER_AGENT" --pane <pane-id> --timeout 120000`
- Launch bare: no `-- <agent-args>`, no `--profile`/`--extension`/`--session-id`/prompt-file arguments. Those are startup-runtime arguments and are not reproduced here; the worker loads its own global skills and config.
- `<name>`: ticket id lowercased plus suffix (`SYT-987` -> `syt-987-w`, planner -> `df-planner`, driver -> `df-stack-driver`, fix -> `df-fix-<pr>`); max 32 chars; append `-2` if the name is live.
- Verify the launch binding from the `agent_started` result (or `herdr agent get <name>`): `agent == <kind>`, `pane_id == <pane-id>`, `name == <name>`, `interactive_ready == true`, `launch_pending != true`. Mismatch -> reconcile with `agent list` before prompting; never start a second agent in that pane.
- `agent_not_ready` means the agent blocked during startup: inspect with `herdr agent get <name>` and `herdr agent read <name> --lines 60`, wait for idle, then prompt. Never relaunch.
- `agent start` requires an idle shell pane. A pane with a foreground process or another agent is not available.

## Prompt and wait
- Same-wave parallelism: submit without `--wait`.
  `herdr agent prompt <name> "<brief>"`
- Then poll: `herdr agent list` (JSON) each ~45s. States: `working`, `idle`, `done`, `blocked`, `unknown`.
  - `idle`/`done`: collect the outcome.
  - `blocked`: read the last 40 lines, answer ticket-local unambiguous questions with `herdr agent prompt`, escalate everything else. Keep the pane alive.
  - `unknown` past `WORKER_TIMEOUT`: inspect with `agent get`/`agent read`; escalate. Do not re-prompt blindly.
- Sequential checks: `herdr agent wait <name> --until done --timeout <ms>`.
- Long briefs: if `agent prompt` rejects the text, write the brief to `<home>/tmp/dark-factory/<epic>/<ticket>-brief.md` and prompt `Read <absolute path> and execute it verbatim.`

## Collect (context firewall)
1. `herdr agent read <name> --source recent-unwrapped --lines 120`
2. Extract only between `=== SUB-ORCHESTRATOR OUTCOME ===` and `=== END ===`; the block carries `herdr: inside|outside` for diagnostics.
3. Block absent or truncated: prompt `Write your Outcome block to <home>/tmp/dark-factory/<epic>/<ticket>-outcome.md and reply with the path only.`, then read that file only.
4. Never read earlier scrollback, diffs, or logs. Outcome block or file only.

## Label and close
- `herdr pane rename <pane-id> "<TICKET> MERGED"` (or `DONE`, `BLOCKED`, `FAILED`).
- Close only ids this run created: `herdr tab close <tab-id>`; for `workspace` layout `herdr workspace close <workspace-id>`.
- Keep panes open on BLOCKED/failure for human inspection and name them in the report.
- Never close the caller pane/tab, another client's panes, or run `herdr server stop`/`herdr session stop`.

## Failure handling
- Command exit 1 with JSON stderr: retry once with the same arguments; a timeout or lost response is uncertain, so inspect state (`agent list`, `pane list`) before retrying a write.
- `dependency_unavailable`/incompatible server/API: treat Herdr as absent for the run, record `herdr: incompatible`, use the in-process fan-out.
- Per-ticket pane failure: mark `pane: failed` in the ledger, run that ticket in-process, never run both.
