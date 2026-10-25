# Dark Factory Herdr Awareness Implementation Plan

> **For agentic workers:** Implement task-by-task with checkbox (`- [ ]`) tracking. This plan is Markdown-only; there is no build step. Verification is read-through plus the live Herdr smoke in Task 5.

**Goal:** Make every jp-skills task check whether it is running inside Herdr and recommend installing it when absent, then make `dark-factory` allocate a real Herdr tab/pane per worker (planner, per-ticket sub-orchestrator, stack driver, fix/rebase agents), launch the user's chosen coding agent in each pane, and drive the run through Herdr's agent API instead of opaque in-process subagents.

**Architecture:** One canonical preflight sentence inserted as the first body section of every skill except `cleanup` (the terminal tail). `dark-factory` gets a deep integration: a Herdr preflight in Step 0, a `WORKER_AGENT` selection at the parameter gate, a pane-allocation helper reference, pane lifecycle wired into PLAN/FAN-OUT/COLLECT/MERGE/CLEANUP, and a rewritten context firewall that allows reading exactly the outcome block from a pane or an outcome file. Herdr is the layout owner; the principal is the only pane controller; workers never touch layout.

**Tech Stack:** Markdown skills, the installed `herdr` CLI 0.9.5 (`herdr agent|pane|tab|workspace|status`, `herdr --skill`), `$HERDR_ENV`/`$HERDR_PANE_ID`/`$HERDR_WORKSPACE_ID`/`$HERDR_TAB_ID`, JSON responses parsed by `jq`.

**Spec:** none yet. Design decisions below are the spec for this change.

## Current state (checked 2026-10-25)

- `main` at `771bd04 release: 7.5.0`; `VERSION` = `7.5.0`.
- Uncommitted work in the tree is unrelated and must not be touched: modified `skills/server-maintenance/SKILL.md` plus untracked `skills/server-maintenance/references/local-disk-maintenance.md`.
- `herdr` 0.9.5 is installed at `~/.local/bin/herdr`; server running, protocol 22, compatible. This session is **not** inside Herdr (`HERDR_ENV` unset), which is exactly the fallback path the new preflight must handle.
- `herdr agent` kinds: `pi|claude|codex|gemini|cursor|devin|agy|cline|omp|mastracode|opencode|copilot|kimi|kiro|droid|amp|grok|hermes|kilo|qodercli|qwen|letta|maki|muse`.
- Skills are linked into harness registries individually (`ln -s <repo>/skills/<name> <registry>/<name>`), so cross-skill links must use `../<skill>/SKILL.md` or `$JP_SKILLS_REPO/skills/<skill>/SKILL.md`; `../shared/` is not reachable from a linked skill.

## Design decisions

1. **Preflight lives in every skill, not in `shared/`.** Linked skill directories cannot see `../shared/`, and the end-of-task `cleanup` tail runs too late to gate dispatch. A two-sentence `## Herdr preflight` section is inserted as the first body section of each skill. `skills/cleanup/SKILL.md` is excluded: it is the terminal tail, and recommending an install after every task is noise.
2. **Present = usable, absent = advisory.** Herdr absence never blocks a task that does not need panes (docs, review, single-file fixes). It blocks only `HERDR=required` factory runs.
3. **The principal owns layout.** Sub-orchestrators are inside Herdr by construction; letting each worker spawn its own panes would multiply tabs without bound and lose the run ledger. Workers are told explicitly not to create, split, move, or close panes.
4. **Default layout is one tab per ticket.** `MAX_PARALLEL` defaults to 6; six split panes in one tab are unreadable. Herdr's sidebar rolls up agent state per workspace, so per-ticket tabs stay observable. `run-tab` and `workspace` are opt-in.
5. **Pane cwd is the orchestrator checkout, not the ticket worktree.** `pipeline` Step 1b owns worktree creation. Pre-creating trees would duplicate ownership and race the pipeline; the worker creates and enters its tree itself.
6. **The context firewall survives pane output.** Pane reads are raw terminal text, so the principal may read only the last 120 lines needed to capture the outcome block, or an outcome file the worker writes under the factory scratch dir. Scrolling back through implementation output is a protocol violation.
7. **One agent per pane, unique names, no focus stealing.** Names are the ticket id lowercased (`syt-987-w`), matching Herdr's `[a-z][a-z0-9_-]{0,31}` rule. `--no-focus` unless `PANE_FOCUS=follow`.
8. **Pane failure degrades per ticket, never duplicates work.** One retry, then that ticket runs in-process with `pane: failed` in the ledger. A stalled worker is inspected, never relaunched alongside its live pipeline.
9. **Only the inherited session.** Never `--session`, `--machine`, `herdr server stop`, `herdr session stop`, or closing panes/tabs/workspaces the run did not create.
10. **Herdr is an execution backend, not a precondition.** `HERDR=auto` uses panes when `HERDR_ENV=1` and otherwise runs today's in-process fan-out. The install recommendation is a single nudge from the principal's preflight, never a pause-with-link gate; only `HERDR=required` is a hard stop.
11. **Workers get no install nudge and no pane commands.** The principal issues every `herdr` command. Workers report one `herdr: inside|outside` line for diagnostics and never recommend installs; a worker has no human reading it, so per-worker nagging is noise.
12. **No invented per-kind launch args.** Launch every worker bare (`agent start <name> --kind <kind> --pane <id>`); the startup extension's harness-specific arguments (`--profile`, `--extension`, `--session-id`, prompt files) exist only because it runs its own runtime, and dark-factory does not reproduce them.

## Global Constraints

- Do not modify, stage, or revert the existing `server-maintenance` changes.
- Preserve every current dark-factory constraint: `pipeline` precondition, context firewall, central auth token, no red merges, no force-push to `main`, no manual ticket-branch merges, outcome schema unchanged.
- ASCII-only new content. No new runtime, extension, or dependency.
- Herdr command syntax must be verified against the installed binary (`herdr agent`, `herdr pane`, `herdr tab`, `herdr workspace`), not invented.
- The pane/agent sequence must match the repo's proven shape in `extensions/startup/src/herdr-runtime.ts` (`createCrew` -> `tab create --workspace <id> --cwd <path> --label <label> --no-focus`; `launch` -> `agent start <name> --kind <kind> --pane <id> -- <args>`) and `herdr agent start --help`.
- Herdr absence degrades to the in-process fan-out; only `HERDR=required` blocks.
- `VERSION` and `CHANGELOG.md` change only in Task 4, as one release.

---

### Task 1: Universal Herdr preflight in every skill

**Files:**
- Modify: every `skills/*/SKILL.md` except `skills/cleanup/SKILL.md` (29 files), plus a mandatory variant for `skills/startup/SKILL.md`
- Test: `grep -L "Herdr preflight" skills/*/SKILL.md` prints only `skills/cleanup/SKILL.md`

**Interfaces:**
- Produces: the exact preflight contract Tasks 2–3 reference ("Herdr present -> continue; absent -> say so once, recommend install, continue in-process").

- [ ] **Step 1: Insert the canonical block**

Insert this section immediately before the first `## ` heading in each of the 29 skills except `startup` (after the title and any intro paragraphs):

```markdown
## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.
```

- [ ] **Step 2: Startup gets the mandatory variant**

Do not insert the generic block into `skills/startup/SKILL.md`. Startup hard-requires Herdr,
the coordinator, and PA supervision; the generic "continue in-process" fallback contradicts its
Boot blocker. Insert instead:

```markdown
## Herdr preflight (mandatory)
Run `test "${HERDR_ENV:-}" = 1` before boot or dispatch. Failure is a hard blocker: say that Startup requires Herdr, recommend installing it (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), and stop - there is no in-process Startup. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr.
```

- [ ] **Step 3: Exclude the terminal tail**

Do not edit `skills/cleanup/SKILL.md`. Its content is appended to every skill and runs at session end; a preflight there would fire after the work.

- [ ] **Step 4: Verify coverage and shape**

Run:
```bash
grep -L "## Herdr preflight" skills/*/SKILL.md
```
Expected: exactly `skills/cleanup/SKILL.md`.

Run:
```bash
grep -c "HERDR_ENV" skills/*/SKILL.md | grep -v ':1$'
```
Expected: only `skills/cleanup/SKILL.md:0` (or no output for it).

Read back three representative skills (`hotfix`, `pipeline`, `startup`) and confirm the section lands before the first real heading and the existing Framework tail is untouched.

- [ ] **Step 5: Commit**

```bash
git add skills/*/SKILL.md
git commit -m "feat(skills): add the Herdr preflight to every task skill"
```

---

### Task 2: Dark-factory Herdr pane reference

**Files:**
- Create: `skills/dark-factory/references/herdr-panes.md`
- Test: every command in it re-checked against `herdr agent`, `herdr pane`, `herdr tab`, `herdr workspace`

**Interfaces:**
- Consumes: the preflight contract from Task 1; the ledger fields from Task 3 (`Pane`, `HERDR_WORKSPACE_ID`).
- Produces: the command recipes Task 3's sections cite by name (`allocate`, `launch`, `prompt`, `poll`, `collect`, `close`).

- [ ] **Step 1: Write the reference**

Content requirements (exact command text, JSON field names, failure handling):

```markdown
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
```

- [ ] **Step 2: Ground the recipe in the proven repo shape**

Read `extensions/startup/src/herdr-runtime.ts` (`createCrew`, `split`, `launch`, `observe`) and `herdr agent start --help`. Confirm the reference reproduces the same primitives and binding checks: `tab create --workspace <id> --cwd <path> --label <label> --no-focus`, optional `pane split <pane> --direction right --cwd <path> --no-focus`, `agent start <name> --kind <kind> --pane <id>` with readiness/binding validation, and `agent list` for observation. Do not add per-kind `--` arguments.

- [ ] **Step 3: Verify against the binary**

Run `herdr agent`, `herdr pane`, `herdr tab`, `herdr workspace`, `herdr agent start --help`, `herdr agent prompt --help`, and `herdr status server --json`. Every command, flag, and JSON field in the reference must appear in that output or in `herdr --skill`. Fix the reference where it does not.

---

### Task 3: Dark-factory SKILL.md integration

**Files:**
- Modify: `skills/dark-factory/SKILL.md`
- Test: read-through against every step below; `grep -n "Herdr\|herdr" skills/dark-factory/SKILL.md` shows the preflight, parameters, fan-out, guardrails, and cleanup

- [ ] **Step 1: Frontmatter description**

Append one clause to the existing description so Herdr-aware runs are discoverable:

```markdown
Each worker runs in its own Herdr pane on the user's chosen coding agent (codex, claude, omp, ...) when Herdr is present; outside Herdr the run recommends installing it and fans out in-process.
```

- [ ] **Step 2: Overview constraints**

Add constraint 10 after "Every ticket proves itself...":

```markdown
10. **Herdr is the layout owner when present.** Step 0 checks `HERDR_ENV`. Inside Herdr, one pane per worker on `WORKER_AGENT`, ledger-recorded ids, and only the principal allocates or closes them. Outside Herdr, recommend the install and use the in-process fan-out; never inspect or control panes from outside Herdr.
```

- [ ] **Step 3: Parameter table**

Add five rows to the section 1 table:

| Parameter | Default | Meaning |
|-----------|---------|---------|
| `HERDR` | `auto` | `auto` (panes when the preflight passes, otherwise recommend the install and fan out in-process) / `required` (stop unless running inside Herdr) / `off` (in-process fan-out only). |
| `WORKER_AGENT` | `same` | Herdr agent kind for every worker, planner, and driver pane: `same` (the caller's kind, resolved from `herdr agent list`) or an explicit kind from `herdr agent` (`codex`, `claude`, `omp`, `gemini`, ...). The binary must be on `PATH`. |
| `PANE_LAYOUT` | `tab-per-ticket` | `tab-per-ticket` (one tab per worker plus `df-plan` and `df-stack-driver` tabs in the caller's workspace) / `run-tab` (one `df-<epic>` tab with split panes) / `workspace` (one workspace for the run). |
| `PANE_FOCUS` | `background` | `background` (`--no-focus`; the user keeps their focus) / `follow` (focus each newly launched worker). |
| `WORKER_TIMEOUT` | `7200000` | Milliseconds without a settled state before a worker is treated as stalled and inspected. |

- [ ] **Step 4: Step 0 preflight**

Insert after item 1 (`pipeline` present) and before the branch check:

```markdown
2. **Herdr preflight.** Run `test "${HERDR_ENV:-}" = 1` and read `references/herdr-panes.md`.
   - Pass: `herdr status server --json` must report `running` with compatible APIs. Record `HERDR_PANE_ID`, `HERDR_WORKSPACE_ID`, `HERDR_TAB_ID`, `PANE_LAYOUT`, and the resolved `WORKER_AGENT` (`same` -> the caller pane's kind from `herdr agent list`, else `omp`). Require `command -v <kind>`; if the binary is missing, stop at the gate and ask for another kind - never substitute silently.
   - Fail: say once that factory panes are unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`, then restart the factory from a Herdr pane). `HERDR=auto` continues with the in-process fan-out and records `herdr: unavailable`; `HERDR=required` stops. Never run pane commands from outside Herdr.
   - This preflight is advisory unless `HERDR=required`: it is an execution-backend switch, not a pause-with-link precondition like `pipeline`. The install recommendation is given once by the principal; workers never repeat it.
```

Renumber the remaining Step 0 items (branch -> 3, task fetch -> 4, confirm -> 5).

- [ ] **Step 5: Flow diagram**

Change the `intake` node label to include the Herdr preflight and add a dashed fan-out note:

```dot
intake [label="Step 0\nPrecondition:\npipeline present?\nHerdr preflight?\n+ confirm epic branch" shape=doublecircle];
```

- [ ] **Step 6: Ledger**

Add a `Pane` column between `Sub-orchestrator` and `Pipeline`:

```markdown
| Ticket | Title (<=6 words) | Wave | Sub-orchestrator | Pane | Pipeline | PR | Deck | Deps | Status | Residual risk (<=12 words) |
```

Add after the table: `Pane` is `<herdr-agent-name>@<pane-id>`, or `in-process`. Record the run header once: `herdr: session=<inherited> workspace=<id> worker-agent=<kind> layout=<mode>` or `herdr: unavailable` / `herdr: off`.

In the same step, extend the Section 4 outcome schema with a diagnostic line after `verify-mode`:

```
herdr:           <inside | outside>
```

A worker reports the inherited environment; `inside` is expected for every pane-launched worker and `outside` proves the in-process fallback. The field is diagnostic only and does not change the DONE/BLOCKED semantics.

- [ ] **Step 7: PLAN (5.1)**

After the Planner dispatch instruction, add:

```markdown
Inside Herdr, the Planner runs in its own `df-plan` tab (`references/herdr-panes.md`: allocate -> launch -> prompt -> collect). Prompt it with the planning brief, poll its state, and read only the structured DAG block (last 120 lines or the outcome file). Keep the tab until cleanup.
```

- [ ] **Step 8: FAN-OUT (5.2)**

Replace the first bullet ("Spin up to `MAX_PARALLEL` sub-orchestrators...") with the pane lifecycle:

```markdown
- Allocate first, then launch. For each ticket in the wave: allocate its pane by `PANE_LAYOUT`, record the tab/pane id in the ledger, then `herdr agent start <worker> --kind "$WORKER_AGENT" --pane <pane-id>`. Pane cwd is the orchestrator checkout; `pipeline` Step 1b creates and enters the ticket worktree.
- Submit each wave's briefs without `--wait` so same-wave workers run concurrently, then poll `herdr agent list` every ~45s. `idle`/`done` -> collect; `blocked` -> read the last 40 lines and answer ticket-local questions or escalate, keeping the pane alive; `unknown` past `WORKER_TIMEOUT` -> inspect and escalate.
- Collect only the outcome block (last 120 lines or the outcome file under `<home>/tmp/dark-factory/<epic>/`). Rename the pane to `<TICKET> <status>`.
- A pane or agent failure retries once, then that ticket runs in-process with `pane: failed` in the ledger. Never run a ticket both in a pane and in-process.
- `HERDR=off` or `herdr: unavailable`: keep the existing in-process sub-orchestrator fan-out unchanged, still enforcing the same brief and outcome schema.
```

- [ ] **Step 9: COLLECT (5.3) and merges (5.4)**

Add to 5.3: `Collect from the pane per references/herdr-panes.md; a malformed block is re-prompted in the same pane, never re-dispatched as a second pipeline.`

Add to 5.4 conflict handling and to the red-CI Fix-agent paragraph: `Dispatch the Rebase/Fix agent in an ephemeral pane (`df-rebase-<pr>` / `df-fix-<pr>`), prompt with handles only (branch, PR, failing check names - never raw logs), wait for `done`, read its one-line result, then close that tab. Keep it open only when it fails.`

- [ ] **Step 10: Stack driver (5.4b)**

Add: `The stack driver gets its own `df-stack-driver` tab and agent. Check in with `herdr agent prompt df-stack-driver "<handle-only message>" --wait --timeout 300000` and read at most its 5-line report. It never allocates panes.`

- [ ] **Step 11: Cleanup (5.6)**

Add a bullet before the worktree removal:

```markdown
- Close only the Herdr tabs/workspaces this run created, recorded in the ledger. Keep panes open on BLOCKED/failure and name them in the report. Never close the caller's pane/tab or another client's panes; never stop the Herdr server or session.
```

- [ ] **Step 12: Sub-orchestrator Brief (section 6)**

Add after the stacking paragraph:

```markdown
Herdr: you run inside a Herdr pane (`HERDR_ENV=1`) owned by the principal. Do not create, split, move, or close panes/tabs/workspaces, and do not start or rename agents. Do not recommend installing Herdr and do not run its install nudge - the principal owns that message. Report `herdr: inside` (or `herdr: outside` when launched in-process) on the outcome's `herdr:` line. If `HERDR_ENV` is not 1 you are running in-process; continue normally and attempt no pane control.
```

- [ ] **Step 13: Guardrails (section 8)**

Add bullets:

```markdown
- **Preflight once, at Step 0.** Workers inherit `HERDR_ENV`; they never re-run pane commands and never emit the install recommendation. One nudge per run, from the principal.
- **Herdr is a backend, not a gate.** Only `HERDR=required` blocks; `auto`/`off` always have an in-process path.
- **Never control panes from outside Herdr.** `HERDR_ENV != 1` -> recommend the install, use in-process.
- **One live agent per pane, unique names, no focus stealing** (`--no-focus` unless `PANE_FOCUS=follow`).
- **Never close panes/tabs/workspaces you did not create**, never `herdr server stop`, `herdr session stop`, `--session`, or `--machine`.
- **Pane output is not context.** Read only the last 120 lines needed for the outcome block or the outcome file. Never scroll back through implementation output.
- **A stalled worker is inspected, not duplicated.** Retry once, then fall back in-process for that ticket.
- **`agent_not_ready` is not failure.** Wait for idle, then prompt; never relaunch.
```

- [ ] **Step 14: Final report (section 9) and Quick Reference**

Add to the report: `herdr: panes used (n) / in-process (m) / unavailable / off`, `worker-agent`, and panes left open. Add Quick Reference rows:

```markdown
| Herdr preflight | Main thread (env + `herdr status server`) | pane/workspace ids, `WORKER_AGENT`, layout |
| Pane lifecycle | Principal only (allocate, launch, prompt, collect, close) | tab/pane ids per ticket |
```

- [ ] **Step 15: Common mistakes**

Append bullets:

```markdown
- **Spawning panes from outside Herdr.** Check `HERDR_ENV` and recommend the install instead.
- **Letting workers allocate panes.** One pane per worker, principal-owned; workers never touch layout.
- **Reading a pane's implementation output.** Outcome block or outcome file only.
- **Leaving the caller's pane focused or resized.** `--no-focus` unless asked otherwise.
- **Closing a tab the run did not create.** Record and close only your own ids.
- **Running a ticket both in a pane and in-process.** One execution path per ticket.
```

- [ ] **Step 16: Commit**

```bash
git add skills/dark-factory/SKILL.md skills/dark-factory/references/herdr-panes.md docs/superpowers/plans/2026-10-25-dark-factory-herdr.md
git commit -m "feat(dark-factory): run each worker in a Herdr pane on the chosen agent"
```

---

### Task 4: Release wiring

**Files:**
- Modify: `README.md` (dark-factory row, Dependencies table, Harness Notes)
- Modify: `CHANGELOG.md` (new `## [7.6.0] - 2026-10-25`)
- Modify: `VERSION` (`7.5.0` -> `7.6.0`)
- Test: `grep -n "Herdr" README.md CHANGELOG.md` shows both

- [ ] **Step 1: README dark-factory row**

Append: `Workers run in Herdr panes on the user's chosen coding agent (codex, claude, omp, ...) when Herdr is present; outside Herdr it recommends the install and fans out in-process.`

- [ ] **Step 2: README dependencies**

Add a row to the Dependencies table:

```markdown
| `dark-factory` (optional) | `herdr` for per-worker panes. Without it the run recommends the install and fans out in-process. |
```

Update the existing `dark-factory` row to keep Linear MCP, `gh`, and the worktree/VM pool.

- [ ] **Step 3: README Harness Notes**

Append: `Every skill starts with a Herdr preflight: inside a pane (`HERDR_ENV=1`) agents may control panes through the herdr CLI; outside one they say so once, point at https://herdr.dev/docs/install/, and continue in-process. dark-factory allocates one pane per worker on the selected agent kind.`

- [ ] **Step 4: CHANGELOG**

Add on top:

```markdown
## [7.6.0] - 2026-10-25

### Added

- Every skill except the terminal `cleanup` tail starts with a Herdr preflight: inside a pane (`HERDR_ENV=1`) it may control panes through the herdr CLI; outside one it says so once, recommends `curl -fsSL https://herdr.dev/install.sh | sh`, and continues in-process.
- `dark-factory` is Herdr-aware: `HERDR` (auto/required/off), `WORKER_AGENT` (same or an explicit `herdr agent` kind such as codex, claude, omp), `PANE_LAYOUT` (tab-per-ticket/run-tab/workspace), `PANE_FOCUS`, and `WORKER_TIMEOUT`. The principal allocates, launches, polls, collects from, and closes one pane per worker (planner, per-ticket sub-orchestrator, stack driver, ephemeral fix/rebase agents) and records ids in the ledger. The context firewall now allows only the outcome block from the pane or an outcome file.

### Verification

- All Herdr commands and JSON fields re-checked against herdr 0.9.5 (`herdr --skill`, `herdr agent|pane|tab|workspace`, `herdr status server --json`).
- Preflight coverage: `grep -L "## Herdr preflight" skills/*/SKILL.md` returns only `skills/cleanup/SKILL.md`.
- Live smoke inside a Herdr pane: tab create -> `agent start --kind omp` -> prompt -> `agent read` -> tab close, plus the absent-Herdr path from a plain shell.
```

- [ ] **Step 5: Version bump and commit**

```bash
printf '7.6.0\n' > VERSION
git add README.md CHANGELOG.md VERSION
git commit -m "release: 7.6.0"
```

---

### Task 5: Verification

**Files:** none modified.

- [ ] **Step 1: Static coverage**

```bash
grep -L "## Herdr preflight" skills/*/SKILL.md          # only skills/cleanup/SKILL.md
grep -n "HERDR\|herdr" skills/dark-factory/SKILL.md | wc -l   # > 20
grep -n "references/herdr-panes.md" skills/dark-factory/SKILL.md
grep -n "herdr:           <inside | outside>" skills/dark-factory/SKILL.md
grep -n "Do not recommend installing Herdr" skills/dark-factory/SKILL.md
```
Read `skills/dark-factory/SKILL.md` end to end and trace: Step 0 preflight -> parameter gate -> ledger Pane column -> PLAN -> FAN-OUT -> COLLECT -> MERGE -> CLEANUP -> Brief -> Guardrails -> Report. No step may both require panes and omit the outside-Herdr fallback, and no worker-facing text may contain the install recommendation.

- [ ] **Step 2: Absent-Herdr path (runs here, outside Herdr)**

```bash
env -u HERDR_ENV bash -c 'test "${HERDR_ENV:-}" = 1 && echo inside || echo "outside: recommend install"'
```
Expected: `outside: recommend install`. Confirm no pane command is issued from this shell.

- [ ] **Step 3: Live pane smoke inside Herdr**

From a Herdr pane (`HERDR_ENV=1`), run the reference's sequences against a scratch repo:

```bash
herdr status server --json | jq -e '.running and .compatible and .endpoint_compatible'
tab=$(herdr tab create --workspace "$HERDR_WORKSPACE_ID" --cwd "$PWD" --label df-smoke --no-focus)
tab_id=$(printf '%s' "$tab" | jq -r '.result.tab.tab_id')
pane_id=$(printf '%s' "$tab" | jq -r '.result.root_pane.pane_id')
herdr agent start df-smoke-w --kind omp --pane "$pane_id" --timeout 120000
herdr agent prompt df-smoke-w "Reply with exactly: SMOKE-OK" --wait --timeout 120000
herdr agent read df-smoke-w --source recent-unwrapped --lines 40
herdr tab close "$tab_id"
```
Expected: `SMOKE-OK` appears in the read, `agent list` shows `df-smoke-w` before close, and `tab close` succeeds. Repeat once with `--kind codex` (or `claude`) to prove the kind selection.

- [ ] **Step 4: Single-ticket factory run**

With a real test epic and `AUTO_MERGE=false`, `MAX_PARALLEL=1`, `HERDR=required`, `WORKER_AGENT=omp`: confirm one `df-<ticket>` tab exists, the ledger carries `Pane` and the run header, the worker's outcome block is the only thing read and carries `herdr: inside`, the worker emitted no install recommendation, the pane is labelled and closed on success, and the report shows `herdr: panes used (1)`.

- [ ] **Step 5: Failure paths**

- Block a worker (ask it a question): the principal sees `blocked`, reads the last 40 lines, and the pane stays open.
- Point `WORKER_AGENT` at a missing binary: Step 0 stops at the gate with the kind named.
- Close a worker's pane mid-run: the principal records `pane: failed` and re-runs that ticket in-process exactly once.

---

## Risks and limits

- **Long briefs.** `agent prompt` uses bracketed paste, but a rejected prompt must fall back to a brief file under the factory scratch dir; the reference covers this.
- **Agent kinds vary by machine.** The gate checks `command -v <kind>`; a missing kind is a user question, not a substitution.
- **Workers are separate agent processes.** They do not share the principal's conversation; the brief must stay fully self-contained (it already is).
- **Herdr API drift.** Methods and JSON fields are versioned; the reference must be verified against the installed binary, and a missing method is not permission to upgrade or stop a server.
- **Tab-per-ticket observability.** The user watches state from the Herdr sidebar, not one screen; `PANE_LAYOUT=run-tab` is the single-screen alternative.
- **Logout/resume semantics.** Panes keep the agent processes alive across detach; this plan does not claim persistence of the factory ledger across a server restart beyond what Herdr guarantees.
