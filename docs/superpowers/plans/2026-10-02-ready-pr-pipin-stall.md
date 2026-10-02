# Ready-PR + Pipin-Stall + Hotfix Verify Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Hotfix ships a ready PR, pipeline/dark-factory never open drafts, pipeline activation can't stall on a bare-text turn, hotfix reuses intake creds for post-fix auth verification.

**Architecture:** Duplicate a one-line ready-PR contract verbatim in three skills (no shared include); add terminal SHIP step to hotfix; fuse pipeline activation line with first Step 1 action plus a 2-minute stall rule; extend hotfix VERIFY with creds-reuse auth check.

**Tech Stack:** Markdown SKILL.md edits, `gh` CLI for PR create/ready, `git` for scoped add/commit/push.

## Global Constraints

- Hotfix never leaves the current branch; SHIP commits on the branch you are on, never cuts a fix branch.
- SHIP uses `git add` of approved-scope paths only; unrelated dirty files recorded as excluded at intake are never added.
- PRs are always ready, never `--draft`; if the repo defaults to drafts, run `gh pr ready` in the same step.
- Hotfix never merges; on the target branch itself (e.g. `main`), stop-and-report instead of opening a PR to self.
- Creds/token held in memory, passed via env, never baked into files, never printed in logs, report, or PR body — record only `creds: provided (redacted)` / `token: provided (redacted)` or `token: not needed`.
- Reuse Step 1 intake creds first; ask for a token set only when missing, expired, or lacking scope.
- Hotfix VERIFY is repro-after with auth, not a QA deck (that stays `pipeline` Step 9).
- Dark-factory merge decision unchanged: `AUTO_MERGE=false` still stops at open PRs (now open-ready).
- Never force-push the target branch; never bypass repository hooks.
- Discovery metadata ships in the same change: hotfix frontmatter, README effect cell, CHANGELOG.md + VERSION.

---

## File Structure

- Modify: `hotfix/SKILL.md` — frontmatter description, constraints 1-2, VERIFY token check, new Step 7 SHIP, one Common-mistakes line.
- Modify: `pipeline/SKILL.md` — Activation block, Step 5 ready-PR lines, one Common-mistakes line.
- Modify: `dark-factory/SKILL.md` — Sub-orchestrator Brief, outcome schema `pr:` line, one Common-mistakes line.
- Modify: `README.md` — hotfix orchestration effect cell (one row).
- Modify: `CHANGELOG.md` + `VERSION` — new 1.3.0 entry.
- Existing: `docs/superpowers/specs/2026-10-02-ready-pr-pipin-stall-design.md` — spec, already written, uncommitted; committed with this change.

---

### Task 1: Hotfix SKILL.md — SHIP + creds-reuse VERIFY + frontmatter

**Files:**
- Modify: `hotfix/SKILL.md:1-4` (frontmatter)
- Modify: `hotfix/SKILL.md:10-13` (overview sequence)
- Modify: `hotfix/SKILL.md:20-34` (constraints)
- Modify: `hotfix/SKILL.md:96-101` (VERIFY)
- Create: `hotfix/SKILL.md:102` (Step 7 SHIP, inserted after VERIFY, before Common mistakes)

**Interfaces:**
- Consumes: spec `docs/superpowers/specs/2026-10-02-ready-pr-pipin-stall-design.md` Decisions (SHIP, scoped-add, token reuse).
- Produces: SHIP step name + ready-PR contract sentence that Tasks 2-3 duplicate verbatim: `PRs are always opened ready, never --draft; if the repo defaults to drafts, run gh pr ready in the same step.`

- [ ] **Step 1: Confirm failing baseline**

Run: `grep -n "never commits" hotfix/SKILL.md; grep -n "SHIP\|gh pr create\|token" hotfix/SKILL.md || true`
Expected: FAIL — `never commits` present in frontmatter + constraints, no SHIP / `gh pr create` / token-reuse lines.

- [ ] **Step 2: Rewrite frontmatter description**

Replace line 3 with:

```markdown
description: Use when fixing a bug in place on your current branch — stays on the branch you are on, confirms the issue with an opt-in live repro, checks whether the bug pattern is widespread with conditional 1-to-3 issue-spread analysis, then shows a dead-simple plan for approval before fixing every site, verifying with reused session creds, and shipping a ready PR.
```

- [ ] **Step 2b: Update overview sequence**

Replace the overview sequence (lines 10-11):

```markdown
Fast, robust, in-place bug fixes on the branch you are already on. The sequence is fixed:
**INTAKE -> CONFIRM -> SPREAD -> PLAN -> FIX -> VERIFY -> SHIP**.
```

- [ ] **Step 3: Rewrite constraints 1-2, extend constraint 6**
Replace constraints 1-2 (lines 22-25) with:

```markdown
1. **Never leave the current branch.** No worktree, no new branch, no checkout change.
   Confirm with `git branch --show-current` at intake and stay there. SHIP commits on this branch.
2. **Always ship a ready PR, never merge.** After VERIFY, commit the scoped fix, push, and open the PR ready — never `--draft` (`gh pr ready` in the same step if the repo defaults to drafts). You never merge; the PR owner does. On the target branch itself (e.g. `main`), stop-and-report instead of opening a PR to self.
```

Append to constraint 6 (after line 34):

```markdown
   The same hygiene covers the post-fix token set: reuse Step 1 intake creds first; ask only when missing, expired, or lacking scope. Held in memory, passed via env, never in files, logs, report, or PR body — record only `token: provided (redacted)` or `token: not needed`.
```

- [ ] **Step 4: Extend VERIFY with creds-reuse auth check**

Append after VERIFY item 3 (line 101):

```markdown
4. Reuse the Step 1 intake creds first for any authenticated check; ask for a token set (what token, what scope/expiry, where to paste) only when missing, expired, or lacking scope. Missing/insufficient token is a single stop-and-report question — never fake the authenticated path. This is repro-after with auth, not a QA deck.
```

- [ ] **Step 5: Insert Step 7 SHIP after VERIFY**

```markdown
### Step 7 - SHIP

1. Re-check `git status --short` against the approved scope; `git add` approved-scope paths only — unrelated dirty files recorded as excluded at intake are never added.
2. Commit on the current branch (repo's commit convention per `git log --oneline -10`), push (`--set-upstream` when needed).
3. `gh pr create` ready, never `--draft`; body carries what/where/risk/repro + `token: provided (redacted)` or `token: not needed`, never the value. If created draft by repo default, run `gh pr ready` immediately.
4. Guard: on the target branch itself, stop-and-report instead of opening a PR to self.
5. Report the PR URL line with the diff stat. Done means the ready PR exists, not just working-tree edits.
```

- [ ] **Step 6: Add Common-mistakes line**

Append to the Common mistakes list:

```markdown
- Ending at working-tree edits without a ready PR — done means the PR URL is reported.
```

- [ ] **Step 7: Verify Task 1**

Run: `grep -n "gh pr create\|gh pr ready\|approved-scope paths only\|reused session creds\|stop-and-report instead of opening a PR to self" hotfix/SKILL.md`
Expected: PASS — all five match; `grep -n "never commits, pushes" hotfix/SKILL.md` returns nothing.

- [ ] **Step 8: Commit**

```bash
git add hotfix/SKILL.md
git commit -m "feat(hotfix): ship ready PR with creds-reuse verify"
```

---

### Task 2: Pipeline SKILL.md — ready-PR Step 5 + activation fusion

**Files:**
- Modify: `pipeline/SKILL.md:28-29` (Activation)
- Modify: `pipeline/SKILL.md:355-361` (Step 5 PR)

**Interfaces:**
- Consumes: Task 1 ready-PR contract sentence (duplicate verbatim).
- Produces: fused-activation wording + `gh pr view --json` confirm (unchanged) for Task 3 reference.

- [ ] **Step 1: Confirm failing baseline**

Run: `grep -n "draft\|same turn as the first Step 1 action\|2 min" pipeline/SKILL.md || true`
Expected: FAIL — no draft/activation-fusion lines.

- [ ] **Step 2: Fuse Activation with first action + stall rule**

Replace lines 28-29 with:

```markdown
**Activation.** When this skill activates, open with exactly this line as a header, in the same turn as the first Step 1 action (git state + worktree + supervisor spawn) — never end a turn on the line alone: `Oh yeah, it's piping time! 🚀🔧🎉🤖💥`
Stall rule: no user-visible progress within ~2 min of activation → emit the intake block and continue without waiting.
```

- [ ] **Step 3: Add ready-PR to Step 5**

Append after line 358 (`re-verifies the committed tree, pushes, and opens the PR with a structured body.`):

```markdown
PRs are always opened ready, never --draft; if the repo defaults to drafts, run gh pr ready in the same step.
```

- [ ] **Step 4: Add Common-mistakes line**

Append to the Common mistakes list (after line 615 area):

```markdown
- **Opening a draft PR or ending a turn on the activation line alone.** PRs are always ready (`gh pr ready` repair when the repo defaults to drafts); the activation line ships with the first Step 1 action.
```

- [ ] **Step 5: Verify Task 2**

Run: `grep -n "never --draft\|gh pr ready\|same turn as the first Step 1 action\|Stall rule" pipeline/SKILL.md`
Expected: PASS — four matches across Activation + Step 5 + mistakes.

- [ ] **Step 6: Commit**

```bash
git add pipeline/SKILL.md
git commit -m "feat(pipeline): ready-PR Step 5 and fused activation"
```

---

### Task 3: Dark-factory SKILL.md — ready-PR Brief + outcome schema

**Files:**
- Modify: `dark-factory/SKILL.md:190-213` (outcome schema)
- Modify: `dark-factory/SKILL.md:310-336` (Sub-orchestrator Brief)

**Interfaces:**
- Consumes: Task 1 ready-PR contract sentence.
- Produces: `pr: <ready URL>` schema line; merge decision unchanged.

- [ ] **Step 1: Confirm failing baseline**

Run: `grep -n "draft\|ready" dark-factory/SKILL.md || true`
Expected: FAIL — no ready/never-draft lines (only unrelated `already` hits, if any).

- [ ] **Step 2: Amend Sub-orchestrator Brief overrides**

In the Brief (section 6), after the `don't merge` override line, insert:

```markdown
Open the PR as ready, never draft (`gh pr ready` in the same step if the repo defaults to drafts). The merge decision is unchanged: `AUTO_MERGE=false` still stops at open PRs (now open-ready).
```

- [ ] **Step 3: Tighten outcome schema pr line**

Replace `pr: <PR URL - REQUIRED; "none" is a protocol violation>` with:

```markdown
pr: <ready PR URL - REQUIRED; "none" is a protocol violation; draft is a protocol violation>
```

- [ ] **Step 4: Add Common-mistakes line**

Append to the Common mistakes list:

```markdown
- **Accepting a draft PR as DONE.** Every outcome PR is ready (`gh pr ready` repair when the repo defaults to drafts); draft is a protocol violation like "none".
```

- [ ] **Step 5: Verify Task 3**

Run: `grep -n "never draft\|draft is a protocol violation\|open-ready" dark-factory/SKILL.md`
Expected: PASS — three matches (Brief, schema, mistakes).

- [ ] **Step 6: Commit**

```bash
git add dark-factory/SKILL.md
git commit -m "feat(dark-factory): ready-PR outcomes, merge decision unchanged"
```

---

### Task 4: Metadata — README, CHANGELOG, VERSION, spec commit

**Files:**
- Modify: `README.md:20` (hotfix effect cell)
- Modify: `CHANGELOG.md` (new entry)
- Modify: `VERSION` (1.2.0 → 1.3.0)
- Add: `docs/superpowers/specs/2026-10-02-ready-pr-pipin-stall-design.md` (already on disk, uncommitted)

**Interfaces:**
- Consumes: Tasks 1-3 skill text.
- Produces: consistent discovery metadata; final green grep gate.

- [ ] **Step 1: Confirm failing baseline**

Run: `grep -n "never commits" README.md; cat VERSION`
Expected: FAIL — README still says `never commits`; VERSION still `1.2.0`.

- [ ] **Step 2: Update README effect cell + CHANGELOG + VERSION**

README line 20 hotfix row effect cell becomes: `Commits scoped fix on current branch + opens ready PR, never merges`.

Prepend to CHANGELOG.md under a new heading:

```markdown
## [1.3.0] - 2026-10-02

### Changed

- `hotfix` now ships a ready PR: scoped commit on the current branch (approved-scope `git add` only), push, `gh pr create` ready never `--draft` (`gh pr ready` repair), stop-and-report on the target branch; VERIFY reuses Step 1 intake creds for auth checks (ask only when missing/expired/lacking scope, session-only hygiene, never in PR body).
- `pipeline` Step 5 opens ready PRs (`gh pr ready` repair); activation line ships in the same turn as the first Step 1 action with a ~2 min stall rule (emit intake block, continue).
- `dark-factory` outcomes require ready PR URLs (draft is a protocol violation); `AUTO_MERGE` merge decision unchanged.
```

Set VERSION to `1.3.0`.

- [ ] **Step 3: Final verification gate**

Run: `grep -rn "never commits, pushes" hotfix/SKILL.md README.md || echo CLEAN; grep -n "gh pr ready" hotfix/SKILL.md pipeline/SKILL.md dark-factory/SKILL.md; cat VERSION`
Expected: PASS — first grep prints CLEAN; second shows all three skills; VERSION prints `1.3.0`.

- [ ] **Step 4: Commit**

```bash
git add README.md CHANGELOG.md VERSION docs/superpowers/specs/2026-10-02-ready-pr-pipin-stall-design.md
git commit -m "docs: ready-PR metadata and spec (v1.3.0)"
```

---

## Self-Review

- Spec coverage: SHIP (§Decisions hotfix) → Task 1; scoped-add guard → Task 1 Step 5.1; creds-reuse + hygiene + repro-after-not-deck → Task 1 Steps 3-4; pipeline ready-PR → Task 2 Step 3; activation fusion + 2-min rule → Task 2 Step 2; dark-factory Brief + schema + merge-unchanged → Task 3 Steps 2-3; frontmatter/README/CHANGELOG/VERSION → Tasks 1-2 + Task 4. Read-only skills untouched per scope.
- Placeholder scan: none — every step has exact replacement text, grep commands with expected outputs, explicit commit messages.
- Type consistency: ready-PR sentence identical across Tasks 1-3; `gh pr ready` repair in all three; `token: provided (redacted)` / `token: not needed` wording matches constraint 6.
