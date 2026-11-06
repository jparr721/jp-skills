---
name: jp-hotfix
description: Use for a small scoped bug that should ship through a pull request.
---

# Hotfix


## Overview

Fast, robust bug fixes through a ready PR and merge. The sequence is fixed:
**INTAKE -> CONFIRM -> SPREAD -> PLAN -> FIX -> REVIEW+VERIFY -> SIMPLIFY -> FINAL -> SHIP**.
SPREAD fans out only when triage justifies it; live repro runs only when you opt in.
No phase is skipped otherwise.

Before dispatch, read the shared authority at the installed `jp-pipeline` skill's `references/workflow-policy.md`, or `$JP_SKILLS_REPO/skills/jp-pipeline/references/workflow-policy.md`. Use the inherited per-change budget (hotfix maximum one); do not spawn a full task crew. Use this skill for a small, knowable bug.

Start or inherit a single-item hotfix scope through the bounded host in that policy before dispatch. Route its narrow assignments, single review and completion through the host; never create a separate scope to escape an inherited budget. Default the landing mode to `merged`; select `ready-pr` only when the user requests no merge or a parent workflow owns landing.

**Non-negotiable constraints:**

1. **Isolate the fix.** Reuse a suitable task branch or create a worktree and branch from the target. Keep unrelated dirty changes untouched.
2. **Ship by default.** Open a ready PR, follow CI, fix failures, merge when checks and review pass, and verify the recorded merge and applicable post-merge checks. If the user says not to merge, leave the ready PR open and verify its checks.
3. **Stay in scope.** Keep unrelated dirty files excluded; resolve ordinary implementation choices without an approval prompt.
4. **Confirm the cause.** Pin the relevant source and evidence before fixing; ask only when a missing fact blocks the fix.
5. **No silent scope creep.** Anything beyond the requested fix becomes a follow-up or a `jp-pipeline` run.
6. **Creds stay session-only.** Live-repro credentials are held in memory and passed via
   env, never baked into files, never printed in logs or the report — record only
   `creds: provided (redacted)`. Never persist them to the skill, spec, or scratch.
   The same hygiene covers the post-fix token set: reuse Step 1 intake creds first; ask only when missing, expired, or lacking scope. Held in memory, passed via env, never in files, logs, report, or PR body — record only `token: provided (redacted)` or `token: not needed`.

## When to Use

- A bug on your current branch, including "this UI bug might exist elsewhere".
- The fix scope is knowable after a short triage (one file to a handful).
- When NOT to use: features, refactors, migrations, auth changes, multi-system work
  (use `jp-pipeline`); a whole epic (use `jp-dark-factory`).

## Flow

### Step 1 - INTAKE

1. Snapshot git state: `git status --short`, `git branch --show-current`. Unrelated dirty
   files are recorded as excluded, not touched.
2. Learn the repo's rules for the area you expect to touch: `AGENTS.md` / `CLAUDE.md` /
   `CONTRIBUTING.md` plus any per-directory guide. Follow existing patterns.
3. Use the supplied symptom and evidence. Request missing steps or credentials only when they are necessary to proceed. Respect the requested verification mode.

### Step 2 - CONFIRM

1. Observe the symptom (browser, CLI, logs, or pasted evidence) and pin the exact source
   lines responsible — file paths plus line ranges.
2. State the pin with observed evidence. If the cause is not yet pinned, continue investigation, collect independent evidence, and test hypotheses; ask only for information unavailable through authorized sources. Do not treat a guess as a confirmed pin.

### Step 3 - SPREAD (issue spread analysis, conditional 1→3)

1. Run 1 triage scout over the confirmed pattern: same-pattern search (copied logic,
   sibling handlers), same-component sweep (shared component/util callers), and
   blame/history check (when the pattern was introduced, what else came with it).
2. Fan to 3 parallel scouts — one per lens above — only when triage finds 2+ suspect
   sites or the bug sits in a shared component/util. Otherwise stay single.
   (Reversible: flip to always-3 with a one-line change here if recall proves low.)
3. Output is a site list: confirmed vs suspected, with file + lines each. Suspected
   sites are verified during FIX, not assumed.

### Step 4 - PLAN

Record a concise plan and continue without asking for approval:

```text
what:   <one-line fix>
where:  <files, confirmed + suspected sites>
spread: <single-site | N sites via <lens>>
risk:   <what could break, one line>
repro:  <how the fix is proven, one line>
```

Name unrelated dirty files as excluded. Findings outside the request are follow-ups.

### Step 5 - FIX

Single implementer fixes every scoped site with the same pattern — no drive-by
refactors, no second convention beside the existing one. Commit per site/fix unit as you go (repo convention, message states decision/why) — never hold the whole fix uncommitted until SHIP. Suspected sites that do not
reproduce the bug are left untouched and reported as checked-clean.

### Step 6 - REVIEW+VERIFY (pr-review-toolkit light + repro)

1. **Review.** Run the `jp-pr-review-toolkit` light variant once over the scoped diff: one sweep
   agent across all five angles, one combined Level plus Splinter challenge, verdict block
   required. Pass the confirmed pin as the task source. The canonical review, lighter than the
   pipeline full fight: no defense round, no second completed review. A missing verdict leaves the attempt unresolved. Reconcile with the owner; if the host proves the attempt ended without a valid verdict, retry with a new assignment key. Continue independent work while truly uncertain effects are reconciled.
2. **Enforce** the verdict: FIX-THEN-SHIP must-fix clears here like any other scoped site;
   BLOCK stops SHIP and hands the work to `jp-pipeline` with the verdict and inherited budget attached. The handoff does not grant a new review round.
3. Repro after: show the same observation passing where it failed before.
4. Verify in the requested mode. In `ci-only` mode use CI for tests, typecheck and lint; otherwise run checks suited to the change. Add regression coverage when required by the request or repository.
5. Report the diff stat, the verdict, plus what was checked-clean, then continue to SIMPLIFY (no handoff — continue through PR, CI, merge, and verification).
6. Reuse the Step 1 intake creds first for any authenticated check; ask for a token set (what token, what scope/expiry, where to paste) only when missing, expired, or lacking scope. For a missing or insufficient token, ask once and continue independent work while waiting; never fake the authenticated path. This is repro-after with auth, not a QA deck.

### Step 7 - SIMPLIFY

Final code pass, once. Skip only if the user said "skip the simplify pass"; never runs after BLOCK.

1. Invoke `jp-code-simplifier` with `caller: hotfix`, scope = the requested paths' diff, and the Step 6 gate (scoped typecheck/lint on touched files plus the repro-after observation).
2. It applies only proven-equivalent candidates and reverts any that turn the gate red. Anything bigger is a follow-up, never an inline addition — the requested scope still bounds the diff.
3. No re-review: the light verdict stands, and simplify edits are reported as unreviewed.
4. Log one line, then continue to FINAL: `simplify: applied=<x> dropped=<y> | re-verify: <green | skipped, nothing applied>`.

### Step 8 - FINAL

Record the verdict, simplify result, diff, risk and verification evidence. Continue without a separate approval prompt. A BLOCK or an unresolved required finding must be addressed before landing.

### Step 9 - SHIP

1. Commit only the scoped changes and push the task branch. Open a ready PR against the selected target.
2. Follow the current PR head's CI to completion. Fix failures and repeat checks after any head change. Respect `ci-only` when requested.
3. By default, merge the green PR using the repository's convention and an exact-head guard. If the user requests no merge, leave it open and ready.
4. Read back the PR state and merge commit, fetch the target, confirm the commit is on it, and follow applicable post-merge CI or deployment verification. Report separately what was and was not verified.
5. Complete the bounded scope with the actual PR, worktree and head evidence. Report the PR URL and outcome.

## Common mistakes

- Fixing the first site without spread triage — the copy-paste sibling survives.
- Planning off the symptom description instead of a confirmed pin.
- Touching unrelated dirty files found at intake.
- Baking repro creds into files, logs, or the report instead of `provided (redacted)`.
- Expanding scope mid-fix instead of stopping at the requested scope.
- Ending at a ready PR when merge was requested or is the default.
- Skipping the light review because the fix "is obvious" — obvious fixes still verdict.
- Shipping past a BLOCK verdict — BLOCK hands to `jp-pipeline`, never to SHIP.
- Using SIMPLIFY to widen the fix — it polishes the approved diff only; new sites or refactors are follow-ups.

## Framework tail

Before finishing, read `../jp-cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/jp-cleanup/SKILL.md`) and follow it.
