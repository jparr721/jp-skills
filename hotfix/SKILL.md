---
name: hotfix
description: Use when fixing a bug in place on your current branch — stays on the branch you are on, confirms the issue with an opt-in live repro, checks whether the bug pattern is widespread with conditional 1-to-3 issue-spread analysis, then shows a dead-simple plan for approval before fixing every site. Edits the working tree only, never commits, pushes, or merges.
---

# Hotfix

## Overview

Fast, robust, in-place bug fixes on the branch you are already on. The sequence is fixed:
**INTAKE -> CONFIRM -> SPREAD -> PLAN -> FIX -> VERIFY**.
SPREAD fans out only when triage justifies it; live repro runs only when you opt in.
No phase is skipped otherwise.

`hotfix` is the lightweight sibling of `pipeline`. Reach for `pipeline` when the work is
a feature, a refactor, a migration, an auth change, or anything spanning multiple systems —
it buys worktree isolation, deliberation, review rounds, and QA proof. Reach for `hotfix`
when a bug is small, its scope is knowable, and you want it fixed where you stand.

**Non-negotiable constraints:**

1. **Never leave the current branch.** No worktree, no new branch, no checkout change.
   Confirm with `git branch --show-current` at intake and stay there.
2. **Never commit, push, open a PR, or merge.** Working tree edits only. You inspect
   the diff and commit it yourself.
3. **Never touch files outside the approved scope.** Unrelated dirty files found at
   intake are off-limits; name them in the plan as explicitly excluded.
4. **Never plan off a guess.** The confirm gate pins exact source lines first; without
   a pin, stop and ask.
5. **No silent scope creep.** Anything past the approved scope becomes a follow-up or a
   `pipeline` run, never an inline expansion.
6. **Creds stay session-only.** Live-repro credentials are held in memory and passed via
   env, never baked into files, never printed in logs or the report — record only
   `creds: provided (redacted)`. Never persist them to the skill, spec, or scratch.

## When to Use

- A bug on your current branch, including "this UI bug might exist elsewhere".
- The fix scope is knowable after a short triage (one file to a handful).
- When NOT to use: features, refactors, migrations, auth changes, multi-system work
  (use `pipeline`); a whole epic (use `dark-factory`).

## Flow

### Step 1 - INTAKE

1. Snapshot git state: `git status --short`, `git branch --show-current`. Unrelated dirty
   files are recorded as excluded, not touched.
2. Learn the repo's rules for the area you expect to touch: `AGENTS.md` / `CLAUDE.md` /
   `CONTRIBUTING.md` plus any per-directory guide. Follow existing patterns.
3. Ask two batched questions: (a) live-repro opt-in — do you want the agent to observe
   the bug live? (b) symptom in one line plus suspected files.
4. If repro is opted in, request exactly what is needed: steps to trigger, URL/command,
   and credentials (per constraint 6). If the repro never materializes, say so and do
   not claim spread findings.

### Step 2 - CONFIRM

1. Observe the symptom (browser, CLI, logs, or pasted evidence) and pin the exact source
   lines responsible — file paths plus line ranges.
2. State the pin back to the user with the observed evidence. No pin → stop and ask;
   never proceed to spread analysis on an unconfirmed guess.

### Step 3 - SPREAD (issue spread analysis, conditional 1→3)

1. Run 1 triage scout over the confirmed pattern: same-pattern search (copied logic,
   sibling handlers), same-component sweep (shared component/util callers), and
   blame/history check (when the pattern was introduced, what else came with it).
2. Fan to 3 parallel scouts — one per lens above — only when triage finds 2+ suspect
   sites or the bug sits in a shared component/util. Otherwise stay single.
   (Reversible: flip to always-3 with a one-line change here if recall proves low.)
3. Output is a site list: confirmed vs suspected, with file + lines each. Suspected
   sites are verified during FIX, not assumed.

### Step 4 - PLAN (dead simple, approval gate)

Present at most 5 lines and wait for a one-word go:

```text
what:   <one-line fix>
where:  <files, confirmed + suspected sites>
spread: <single-site | N sites via <lens>>
risk:   <what could break, one line>
repro:  <how the fix is proven, one line>
```

Unrelated dirty files are named as excluded. Anything discovered past this scope
after approval is a follow-up, not an inline addition.

### Step 5 - FIX

Single implementer fixes every scoped site with the same pattern — no drive-by
refactors, no second convention beside the existing one. Suspected sites that do not
reproduce the bug are left untouched and reported as checked-clean.

### Step 6 - VERIFY

1. Repro after: show the same observation passing where it failed before.
2. Run typecheck/lint scoped to touched files only. No full suite, no review loop,
   no QA deck. A regression test is added only on request.
3. Report the diff stat plus what was checked-clean. Hand back; the user commits.

## Common mistakes

- Fixing the first site without spread triage — the copy-paste sibling survives.
- Planning off the symptom description instead of a confirmed pin.
- Touching unrelated dirty files found at intake.
- Baking repro creds into files, logs, or the report instead of `provided (redacted)`.
- Expanding scope mid-fix instead of stopping at the approved plan.

## Framework tail

Before finishing, read `../shared/cleanup.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/shared/cleanup.md`) and follow it.
