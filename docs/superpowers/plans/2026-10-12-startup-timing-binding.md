# Startup timing + named binding Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add timestamps, completion reports with a 60-min oversize flag, and named folder-bound startups with `.startup/` role overrides to the startup skill family.

**Architecture:** Seven doc-only tasks, one skill per task, reviewer-gated between tasks. No code, no tests, no new skill dirs — `startup-time` is a canonical command block inlined where needed. Verification per task is grep-gate: exact replacement text present, stale text absent.

**Tech Stack:** Markdown skill docs, git, grep. Source spec: `docs/superpowers/specs/2026-10-12-startup-timing-binding-design.md`.

## Global Constraints

- UTC ISO-8601 everywhere via `date -u +%Y-%m-%dT%H:%M:%SZ`; no timers, no live-spin.
- Manager firewall intact: reads outcome blocks + ledger only, never code/diffs/logs.
- Assignment block carries `{kind, procedure, convention-source, acceptance}` plus inlined role override or `none`.
- Skill frontmatter: `name` + `description` only; ≤~500 words per SKILL.md or split to refs.
- One commit per task, in-place on `main`, pushed directly.
- `coding_mins > 60` flags OVERSIZE; single flags never auto-split in flight — retro judges patterns.

---

### Task 1: Dev outcome timing + role-override read

**Files:**
- Modify: `skills/startup-role-dev/SKILL.md`

**Interfaces:**
- Consumes: spec §1 outcome delta (`coding_mins/waited_mins/evidence`), spec §3 reader rule (worker only, read-only).
- Produces: outcome field names `coding_mins`, `waited_mins`, `evidence` that Task 2 (manager enforcement) and Task 4 (report shape) rely on verbatim.

- [ ] **Step 1: Add timing fields to the outcome block section**

In `skills/startup-role-dev/SKILL.md`, under `## Outcome block`, append after the existing outcome sentence (line 35 area):

```markdown
Timing (self-report + evidence): append `coding_mins` (hands-on-keyboard time only — exclude CI waits, review waits, blocked time) + `waited_mins` (CI + blocked + review-wait) + `evidence` (2 lines max: commits since dispatch, test/CI cycles run). Record times honestly; the manager sanity-checks against wall clock (`coding_mins` ≤ dispatched→outcome). Gaming the split is a protocol violation the buddy replay will catch.
```

- [ ] **Step 2: Add role-override read rule**

In the same file, append a new section before `## Framework tail`:

```markdown
## Bound-startup role override

When the assignment block carries a `role-override:` field, treat its content as an additional standing constraint for this item only — scoped to this repo, never generalized. `role-override: none` means defaults apply. Never read `.startup/` files directly; the manager inlines what you need. Never write `.startup/` files.
```

- [ ] **Step 3: Verify with grep**

Run: `grep -c "coding_mins" skills/startup-role-dev/SKILL.md`
Expected: `2` (outcome section + timing paragraph)

Run: `grep -c "role-override" skills/startup-role-dev/SKILL.md`
Expected: `3` (section header + `role-override:` field + `role-override: none`)

- [ ] **Step 4: Commit**

```bash
git add skills/startup-role-dev/SKILL.md
git commit -m "feat: dev outcome timing self-report + role-override read"
```
---

### Task 2: Manager stamps, sanity-check, assignment inline

**Files:**
- Modify: `skills/startup-role-manager/SKILL.md`

**Interfaces:**
- Consumes: Task 1 field names (`coding_mins`, `waited_mins`, `evidence`); spec §1 stamp locations, §3 inline rule.
- Produces: assignment field name `role-override` that Task 6 (intake/binding) relies on; OVERSIZE flag behavior Task 4 relies on.
- [ ] **Step 1: Add stamp + role-override inline to assignment**

In `skills/startup-role-manager/SKILL.md`, under `## Assignment block`, append:

```markdown
Stamp `dispatched_at` (`date -u +%Y-%m-%dT%H:%M:%SZ`) on the `queue.json` row at fan-out. Resolve the bound startup's role override for this item's repo+role (`<bound_root>/.startup/<repo>/<role>.md`; missing or whitespace-only = none) and inline it as `role-override` in the assignment block — worker never reads `.startup/` directly. Precedence for the inlined content, last wins: global `standing-instructions.md` → `.startup/config.md` prefs → the role file. On park/unpark record `parked_at`/`unparked_at`; they accumulate to `parked_mins` in the completion report.
```

- [ ] **Step 2: Extend outcome enforcement with timing + OVERSIZE**

In the same file, under `## Outcome schema enforcement`, append:

```markdown
Timing enforcement: outcome must carry `coding_mins/waited_mins/evidence` (2 lines). Sanity-check only: `coding_mins` ≤ dispatched→outcome wall clock and evidence plausible; mismatch → flag in the completion report, never recompute. `coding_mins > 60` → flag the report `OVERSIZE` and append an open bulletin item `{item, source: oversize, status: open}` at collection time. Never read code/diffs/logs to verify — deep replay is the buddy's job.
```

- [ ] **Step 3: Verify with grep**

Run: `grep -c "dispatched_at" skills/startup-role-manager/SKILL.md`
Expected: `1`

Run: `grep -c "OVERSIZE" skills/startup-role-manager/SKILL.md`
Expected: `1`
Run: `grep -c "role-override" skills/startup-role-manager/SKILL.md`
Expected: `1` (single backticked occurrence; repo+role uses `repo+role` and path forms)

- [ ] **Step 4: Commit**

```bash
git add skills/startup-role-manager/SKILL.md
git commit -m "feat: manager dispatch stamps, timing check, oversize flag"
```

---

### Task 3: Orchestrator — `startup new`, namespaced state, report-handle

**Files:**
- Modify: `skills/startup/SKILL.md`

**Interfaces:**
- Consumes: spec §2 (`completions/`, `report-handle`), §3 (`startup new`, `binding.json`, namespaced state, resolution).
- Produces: command name `startup new` and path `<home>/startup/<name>/` that Tasks 5–6 rely on.

- [ ] **Step 1: Add `startup new` to the dispatch table**

In `skills/startup/SKILL.md`, in the `## Dispatch` table, add a row after the first row:

```markdown
| `startup new <name> [--dir <path>]` | Interactive bound-startup setup (see `skill://startup-intake`), writes `.startup/config.md`, seeds per-name state |
```

- [ ] **Step 2: Namespace state per name**

In the same file, under `## State`, replace the sentence starting `Under \`<home>/startup/\`:` with:

```markdown
State namespaces per named startup: under `<home>/startup/<name>/`: `queue.json`, `ledger.md`, `memory.md` (64KB), `standing-instructions.md`, `bulletin.md`, `resources.json`, `creds/`, `completions/`, plus `binding.json` (`{name, bound_root}`). `queue.json` rows carry `dispatched_at`; `report-handle` points at `completions/<id>.md` (which carries `outcome_at`). Unnamed legacy use resolves to `<home>/startup/default/`. NEVER `tmp/`. `MAX_PARALLEL` default 6 is a ceiling, not a target.
```

- [ ] **Step 3: Add bound-dir resolution**

In the same file, under `## State`, append:

```markdown
Resolution: `startup <prompt>` inside a bound dir resolves the name via the nearest `.startup/config.md` (walk up); explicit `startup <name> <prompt>` works from anywhere. Canonical clock everywhere: `date -u +%Y-%m-%dT%H:%M:%SZ` (UTC ISO-8601); the PA tick reuses it — no parallel clock path.
```

- [ ] **Step 4: Verify with grep**

Run: `grep -c "startup new" skills/startup/SKILL.md`
Expected: `1`

Run: `grep -c "binding.json" skills/startup/SKILL.md`
Expected: `1`

Run: `grep -c "completions/" skills/startup/SKILL.md`
Expected: `2`

- [ ] **Step 5: Commit**

```bash
git add skills/startup/SKILL.md
git commit -m "feat: startup new command, per-name state, report handles"
```

---

### Task 4: Retro scans completions, owns cleanup

**Files:**
- Modify: `skills/startup-retro/SKILL.md`

**Interfaces:**
- Consumes: Task 2 OVERSIZE bulletin items; spec §2 report path + cleanup ownership.
- Produces: none (terminal consumer of reports).

- [ ] **Step 1: Add completions dir to scan sources**

In `skills/startup-retro/SKILL.md`, under `## Scan sources`, replace the first sentence `Scan \`memory.md\` + ledger outcomes since the last retro. Look for:` with:

```markdown
Scan `memory.md` + ledger outcomes + `completions/*.md` since the last retro. Look for:
```

- [ ] **Step 2: Add oversize + timing signal to the weakness scan**

In the same file, append to the scan bullet list:

```markdown
- Oversize pattern (`OVERSIZE` reports, high `coding_mins`): repeated single-worker multi-hour coding runs → split future similar intake into peer-collaborated sub-items.
- Coding-vs-wait split (`coding_mins` vs `waited_mins` + `parked_mins`): long waits are system stalls, not size signal — optimize the system, not the split.
```

- [ ] **Step 3: Add completion-report cleanup to the compress section**

In the same file, under `## 64KB compress`, append:

```markdown
Completion cleanup (retro owns it, runs here only): compress each scanned `completions/<id>.md` to 1 line in `memory.md` (id + coding/wait + verdict + handle), then delete the file. Never delete unscanned reports.
```

- [ ] **Step 4: Verify with grep**

Run: `grep -c "completions/" skills/startup-retro/SKILL.md`
Expected: `2`

Run: `grep -c "OVERSIZE" skills/startup-retro/SKILL.md`
Expected: `1`

- [ ] **Step 5: Commit**

```bash
git add skills/startup-retro/SKILL.md
git commit -m "feat: retro scans completions, owns report cleanup"
```

---

### Task 5: stop-doing routes scoped rules to `.startup/`

**Files:**
- Modify: `skills/startup-stop-doing/SKILL.md`

**Interfaces:**
- Consumes: spec §3 writer rule (setup + boss-via-stop-doing only).
- Produces: write path `.startup/<repo>/<role>.md` that Task 6 setup relies on.

- [ ] **Step 1: Add repo+role scoped routing**

In `skills/startup-stop-doing/SKILL.md`, under `## Append + propagate`, append:

```markdown
Repo+role scope: when the rule names a repo and role in a bound startup (e.g. `stop-doing "QA: no local typecheck in repoA"`), append to `<bound_root>/.startup/<repo>/<role>.md` (create dirs as needed) instead of global `standing-instructions.md`. Global rules keep the existing path. Report names the file (e.g. `Scoped: .startup/repoA/qa.md — no local typecheck`).
```


- [ ] **Step 2: Verify with grep**

Run: `grep -c ".startup/<repo>/<role>.md" skills/startup-stop-doing/SKILL.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add skills/startup-stop-doing/SKILL.md
git commit -m "feat: stop-doing routes repo-role rules to .startup"
```

---

### Task 6: Intake owns `startup new` interactive setup

**Files:**
- Modify: `skills/startup-intake/SKILL.md`

**Interfaces:**
- Consumes: Task 3 command name; Task 5 write path; spec §3 bounded setup + `config.md` shape.
- Produces: `.startup/config.md` shape and `binding.json` that Task 3 resolution relies on.

- [ ] **Step 1: Add `startup new` setup procedure**

In `skills/startup-intake/SKILL.md`, append a new section before `## Framework tail`:

```markdown
## `startup new` interactive setup

`startup new <name> [--dir <path>]` (default dir = cwd). Bounded — never stalls:

1. List repos found in dir; boss confirms/adds/removes.
2. One confirm per repo for move-or-clone (local path vs remote URL); skip allowed, resume on next invoke.
3. Ask local-test command + production/CI verify path once; per-repo override only on deviation.
4. Write `<dir>/.startup/config.md` (name, purpose, repo list, test/verify map) and per-name state `<home>/startup/<name>/` with `binding.json` (`{name, bound_root}`). Seed DevOps `resources.json` locks from the answers.
5. Never write inside repo dirs; repo `.git` stays clean.
```

- [ ] **Step 2: Verify with grep**

Run: `grep -c "startup new" skills/startup-intake/SKILL.md`
Expected: `2` (section header + command mention)

Run: `grep -c "binding.json" skills/startup-intake/SKILL.md`
Expected: `1`

- [ ] **Step 3: Commit**

```bash
git add skills/startup-intake/SKILL.md
git commit -m "feat: intake owns startup new interactive setup"
```

---

### Task 7: Release sync — README, CHANGELOG, VERSION

**Files:**
- Modify: `README.md`, `CHANGELOG.md`, `VERSION`

**Interfaces:**
- Consumes: all Tasks 1–6 (release notes summarize them).
- Produces: released version (no dependents — last task).

- [ ] **Step 1: Bump VERSION to 4.1.0**

In `VERSION`, replace `4.0.0` with `4.1.0`.

- [ ] **Step 2: Add CHANGELOG entry**

In `CHANGELOG.md`, at the top after the preamble paragraph, add (match the existing `## [X.Y.Z] - YYYY-MM-DD` + `### Added` convention):

```markdown
## [4.1.0] - 2026-10-12

### Added

- Worker outcome gains `coding_mins/waited_mins/evidence`; manager stamps `dispatched_at`/`outcome_at`/park intervals, sanity-checks only.
- Per-item `completions/<id>.md` with `OVERSIZE` flag over 60 coding minutes; retro scans and owns cleanup.
- `startup new <name>` binds a folder; `.startup/config.md` identity, `.startup/<repo>/<role>.md` overrides inlined into assignments; `stop-doing` routes scoped rules there.
```

- [ ] **Step 3: Verify release agreement**

Run: `head -c 5 VERSION && grep -c "4.1.0" CHANGELOG.md README.md`
Expected: VERSION prints `4.1.0`, CHANGELOG count ≥ 1, README count ≥ 1 (add a one-line README mention under the startup section if zero).

- [ ] **Step 4: Commit**

```bash
git add VERSION CHANGELOG.md README.md
git commit -m "release: startup timing + named binding v4.1.0"
```
