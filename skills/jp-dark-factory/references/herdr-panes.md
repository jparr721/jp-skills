# Herdr panes for dark-factory

Herdr is the layout owner. The principal allocates and closes; workers never touch layout.
Read `herdr --skill` (or the linked `herdr` skill) before the first command. Verify syntax with `herdr agent`, `herdr pane`, `herdr tab`, `herdr workspace` if any command rejects its arguments.

## Preflight
- `test "${HERDR_ENV:-}" = 1` - outside Herdr, do not run pane commands; select Tern or in-process.
- `herdr status server --json` - require `running`, `compatible`, `endpoint_compatible`.
- `herdr pane current --current` - read `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`; never retarget the user's focused pane.
- `herdr agent` - authoritative kind list; require `command -v <kind>` for the chosen `WORKER_AGENT`.

## Launch and collect

The bounded host owns allocation, dispatch identity and the private inherited manifest. Use `bounded_launch` with `backend: "herdr"` and the inherited scope; the child uses `bounded_attach`. Do not launch or prompt an independent worker with `herdr agent start` or `herdr agent prompt` as a substitute. Follow the shared workflow policy's cross-root receipt requirements; a pane outcome alone is not completion.

Use Herdr inspection only to reconcile the recorded launch and read a bounded outcome. Preserve uncertain ownership and never repeat an uncertain launch.

## Label and close
- `herdr pane rename <pane-id> "<TICKET> MERGED"` (or `DONE`, `BLOCKED`, `FAILED`).
- Close only ids this run created: `herdr tab close <tab-id>`; for `workspace` layout `herdr workspace close <workspace-id>`.
- Keep panes open on BLOCKED/failure for human inspection and name them in the report.
- Never close the caller pane/tab, another client's panes, or run `herdr server stop`/`herdr session stop`.

## Failure handling
- An uncertain launch or lost response stays unresolved; inspect the recorded host and pane state without retrying the launch.
- When the backend is unavailable, use a host-supported in-process dispatch only after ownership is conclusively resolved. If receipts or inherited scope cannot be reconciled, keep the affected operation fenced, recover the original owner, and continue independent work; report the remaining blocker.
