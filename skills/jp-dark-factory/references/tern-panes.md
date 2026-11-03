# Tern panes for dark-factory

Tern is an optional terminal backend, not an agent supervisor. The principal alone creates,
prompts, inspects and closes run-owned blocks. The worker still runs `jp-pipeline`; the outcome
schema and one-pipeline-per-ticket rule are unchanged.

## Preflight

- Check `command -v tern` and `command -v omp`, then `tern ls --json`. A failed command or
  no suitable reachable session means use in-process. Do not start a daemon or create a session
  just to satisfy this preflight. `tern inspect --json` identifies windows; `tern whoami --json`
  identifies the caller when inside a Tern pane. Outside a pane, Tern defaults to the first
  window; choose an existing window explicitly with `--window KEY` when needed. Keep that window
  and the selected existing session fixed for this run. Never target the caller's block.
- `tern new tab` may change focus; there is no documented `--no-focus` option. If this is not
  acceptable, use in-process. Tern does not manage agent status or provide Herdr's agent protocol.
- Tern's daemon launches programs independently of the principal's environment. Do not assume
  it receives `AUTH_TOKEN`; never put a token in commands, terminal input, or brief/outcome files.
  If a worker needs a token and no verified secure environment channel exists, use in-process
  with an approved channel or report the QA blocker.

## Allocate and launch

For each planner, worker, driver or repair agent, create a separate tab in the selected session:

```sh
tern new tab "$SESSION" --cwd "$ORCHESTRATOR_CWD" --keep-open --json -- omp "<non-secret brief>"
```
Use the `--json` option in the position accepted by the installed CLI (`tern new --help`);
record the returned block identity and selected window/session before continuing. If the result
is ambiguous, reconcile with `tern ls --json` and `tern inspect --json`; never guess or retry an
uncertain creation. Use an absolute cwd and distinct names/briefs. `omp` accepts an initial
interactive prompt; its own skills/config must be available, including `jp-pipeline`. Include the
resolved manifest, the backend `tern`, and the outcome-file path in the brief. Do not embed a
secret. Launch all workers of a wave before waiting so they execute concurrently.
- When resolved Startup mode is standalone or `off`, launch OMP with `--no-extensions`:
  `tern new tab "$SESSION" --cwd "$ORCHESTRATOR_CWD" --keep-open --json -- omp --no-extensions "<non-secret brief>"`.
  This prevents an installed Startup extension from auto-attaching in the worker; it also
  disables other auto-discovered extensions. If the run needs one, explicitly load the
  required non-Startup extension with `--extension` after checking its path. Skills, including
  `jp-pipeline`, must remain discoverable. If the current principal is already Startup-bound and
  the user opts out, use a separate non-Startup root; never change the bound root's authority.

## Communicate and collect

- Request that each worker writes only its bounded outcome block to its own absolute file under
  `<home>/tmp/dark-factory/<epic>/`, and writes a short question there when blocked. The planner
  and driver use their own bounded structured result files. These are non-secret coordination
  artifacts, not a substitute for a durable proof record. Poll only these files; Tern's process
  state is not an agent completion signal.
- Send a non-secret follow-up to the same interactive worker using
  `tern send <block-id> paste "<message>"`, then `tern send <block-id> keys Enter`. For blocked
  questions, answer only after reading the bounded question; surface shared decisions once.
  The stack driver receives handle-only check-ins through the same mechanism. Do not assume
  `hub` links independent Tern-launched agents.
- `tern process <block-id> --json` and `tern wait <block-id> --until exit --timeout <seconds>`
  help inspect process state; timeout is seconds, whereas `WORKER_TIMEOUT` is milliseconds.
  An interactive agent may stay alive after an outcome, so do not wait for exit as the completion
  criterion. Never use `tern capture --scrollback` to collect implementation output.
- A malformed or `IN_PROGRESS` outcome goes back to the same owner. On launch failure or timeout,
  inspect the recorded block and process; if state is uncertain or still running, keep it and
  escalate instead of launching a duplicate. Fall back in-process only after confirming the
  original worker is not running and its ownership is resolved.

## Cleanup

After successful collection, `tern close <block-id>` closes only a recorded run-owned block;
retain blocked/failed blocks for inspection. Never close the caller's block, another client's
resources, or stop a shared Tern daemon/session. Remove only owned temporary coordination files
when no longer needed, preserving all required evidence and proof artifacts.
