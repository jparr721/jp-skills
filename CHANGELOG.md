# Changelog

`VERSION` at the repo root is the version source of truth. The installed copy lives in `<canonical-home>/config.json` (`installed_version`); canonical home is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`.

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
