---
name: jp-startup
description: Use to boot a named Startup, route later human requests, or invoke its queue commands.
---

# Startup

One Startup has one central manager and a durable coordinator. The manager captures requests, schedules independent pipeline or hotfix runs, tracks dependencies and outcomes, and calls a PA only when needed for questions. Runs own their review, verification, QA and user-requested landing mode. Do not create a persistent architect, developer and QA crew for new manager-led work.

Manager-led runs require an OMP worker executable even with a Claude Code manager. Missing OMP fails launch before reservation.

Manager-led execution is enabled and covered by repository tests, including a real offline OMP coordinator fixture. Live deployment and legacy nonterminal handover are not verified. Report actual receipts and evidence; do not claim a run completed or landed based on a launch or status alone. Product and runtime names remain `startup`.

## Boot and selection

Read `../../extensions/startup/README.md` for coordinator, harness and pane requirements. Use `/startup new <name> [--dir <JSON-quoted-path>] [-- <work>]`, `/startup select <name> [-- <work>]`, or `/startup` for the nearest bound root. Claude Code uses `startup-claude` and its Startup bridge. Use the installed supported binaries and actual admission evidence. A version difference alone is not a blocker.

Selection stays fixed in the manager chat. `startupRoot` comes from absolute `STARTUP_ROOT` or `<skills home>/startup/<name>` and its canonical binding. An item's repository does not change selection. Load the complete `jp-startup-role-manager` and `jp-startup-loop` sources. The coordinator binds source paths and hashes to sessions: changing these instructions does not re-admit an existing session. Preserve active old sessions. The existing refresh tool does not refresh the manager; a safe manager source handover is not yet implemented. Do not assume a changed manager or loop source can be admitted or call migration tools.

## Work

Save and classify each input with `startup_route`, or use `startup_intake` for explicit intake. Read the full input and attachments. Capture each actionable passage with `startup_capture`; use stable event and capture IDs and current row revisions. Resolve repository, acceptance and dependencies, then start each ready independent item with `startup_run_start {itemId,workflow,limit,target,launchKey,worktree}`. `workflow` is `pipeline` or `hotfix`, `limit` is one or two review rounds, `target` is the target branch, and `worktree` is an absolute Git worktree root. Keep a stable launch key for each assignment and inspect `startup_runs` and actual evidence before reporting an outcome with `startup_run_report {launchKey,state,outcome}`.

Call `startup_ensure_pa {}` only when a PA is needed to help handle questions. A PA is not a prerequisite for independent work. Sweep ready work after each result or new dependency and before waiting. Reconcile an uncertain launch or effect using its original identity; never redispatch it merely because its result is missing.

## Migration and recovery

For an already scoped root, `startup_migrate {migrationId}` adopts eligible undispatched queue rows and reports rows that need reconciliation. For a scoped or unscoped legacy root, `startup_import_legacy {migrationId,sourceRoot}` imports into a separate selected root and preserves a restricted archive of the binding, queue and SQLite snapshot. Nonterminal rows remain `NEEDS_DECISION`; terminal rows remain in the archive. Original files and external transcripts must be preserved. Hashes and snapshots do not fence a live old owner or prove a row was never dispatched. Manager handover and review-budget transfer are unsupported, so imported nonterminal rows remain quarantined; do not re-enter or dispatch them as new work. Unrelated new work can proceed separately in the new root. Do not infer completion or authorization from migration.

Before upgrading, finish and reconcile old work under its original runtime. A separate-root import of a terminal-only queue retains those rows in the archive and returns no unresolved rows; it does not prove old claims, effects or processes are resolved. Preserve the old root and avoid running both roots against the same work. See the README drain-and-switch procedure.

Changed manager and loop source hashes currently prevent an existing manager from admission and tool commands. Manager handover is not yet implemented; do not relabel the old identity or overwrite its binding. Existing legacy crews, claims and grants retain their original recovery path and identities. See the runtime README for exact migration limits and tool availability.

## Commands and state

Use `jp-startup-status`, `jp-startup-retro` or `jp-startup-stop-doing` for their named requests. Existing role and hire instructions remain relevant to legacy work, not the default new-work path. Preserve the selected root's queue, ledger, receipts and unresolved history.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` and follow it.
