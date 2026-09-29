# Hotfix Skill Design

Date: 2026-09-28. Status: approved by user in session; implementation via writing-plans next.

## Decisions

- New `hotfix/` skill: in-place fix on the user's current branch. Never creates a worktree, branch, commit, push, PR, or merge. Working tree edits only; the user inspects the diff and commits.
- Intake snapshots `git status/branch` and treats unrelated dirty files as off-limits; asks two batched questions (live-repro opt-in, symptom + suspected files).
- Live repro is opt-in: on yes, requests steps/creds, observes (browser/CLI/logs), and confirms the symptom before planning. No repro, no spread claim.
- Confirm gate pins exact source lines. No pin → stops and asks; never plans off a guess.
- Issue spread analysis defaults to conditional 1→3 (reversible): 1 triage scout maps same-pattern / same-component / blame-history hits; fans to 3 parallel only on 2+ suspect sites or a shared component/util. Flip to always-3 with a one-line change if recall proves low.
- Plan gate is DEAD simple, 5 lines max (what / where / spread scope / risk / repro check); waits for one-word approval even for 1-file fixes.
- Fix is a single implementer over all scoped sites, same pattern everywhere, no drive-by refactors.
- Verification floor: repro before/after plus typecheck/lint on touched files only. No full suite, no review loop, no QA deck. Regression test only on request.
- Escape hatch: migrations, auth, multi-system changes, or scope creep → stops, names why, points to `pipeline`. Never silently expands.

## Scope

- New files: `hotfix/SKILL.md` (+ Framework tail), one README category-table row, CHANGELOG/VERSION bump per repo rules at implementation time.
- This spec authorizes the skill only. REJECT: mini-pipeline with supervisor/review rounds (that's `pipeline`); single-agent grep-and-fix with no spread stage (misses the copy-paste UI case).
- Next step is the writing-plans skill for the implementation plan, per the brainstorming terminal state.

## Self-review

- Placeholder scan: none — all gates concrete (5-line plan, 1→3 fan rule, touched-file checks).
- Consistency: in-place-only matches no-commit/no-PR; conditional spread matches "for bigger tasks"; floor matches "robust, not bogged down".
- Scope: single-skill addition; no caller migration (nothing references `hotfix` yet).
