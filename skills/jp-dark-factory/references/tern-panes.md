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

## Launch and collect

The bounded host owns allocation, dispatch identity and the private inherited manifest. Use `bounded_launch` with `backend: "tern"` and the inherited scope; the child uses `bounded_attach`. Tern is not an agent supervisor. Do not independently launch or prompt a worker as a substitute for the coordinator. Follow the shared workflow policy's cross-root receipt requirements; a pane outcome alone is not completion.

Use Tern inspection only to reconcile the recorded launch and read a bounded outcome. Preserve uncertain ownership and never repeat an uncertain launch. Never place tokens in terminal input, commands or outcome files.

## Cleanup

After successful collection, `tern close <block-id>` closes only a recorded run-owned block;
retain blocked/failed blocks for inspection. Never close the caller's block, another client's
resources, or stop a shared Tern daemon/session. Remove only owned temporary coordination files
when no longer needed, preserving all required evidence and proof artifacts.
