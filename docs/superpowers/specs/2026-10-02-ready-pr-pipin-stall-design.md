# Ready-PR + Pipin-Stall + Hotfix Verify Design

Date: 2026-10-02. Status: drafted from brainstorming; design sections presented, awaiting user approval.

## Problem

- `hotfix` finishes working-tree edits and hands back; agents forget the PR. User has to remind them.
- `pipeline` sometimes stalls right after the `Oh yeah, it's piping time!` line. Observed transcript at pause: line only, no tool call pending. Root cause is a turn-boundary stop after a bare-text turn, not a permission gate (Step 1.8 supervisor spawn + Step 1b worktree execs are the first dispatch/exec gates; verify-mode question in Step 4 is the first legit pause).
- `hotfix` has no post-fix authenticated verification. It should request a token set when the fix needs one and verify what it can check.

## Decisions

- Shared ready-PR contract, duplicated verbatim in three skills (no new shared include; small enough that an include would be a second convention):
  - `hotfix`: new terminal `Step 7 - SHIP` after VERIFY. Commit scoped fix on the current branch (`never leave branch` preserved), push, `gh pr create` ready, never `--draft`. If repo defaults to drafts, run `gh pr ready` in the same step. Guard: on the target branch itself (e.g. `main`), stop-and-report instead of opening a PR to self. VERIFY report gains a PR URL line.
  - `pipeline` Step 5: `never --draft; if created draft, gh pr ready same step` next to the `commit-and-push` invocation. Existing `gh pr view --json` confirm stays.
  - `dark-factory`: Sub-orchestrator Brief + outcome schema gain `ready, never draft`. Merge decision unchanged: `AUTO_MERGE=false` still stops at open PRs (now open-ready, not open-draft); principal still merges in topo order via `gh pr merge`.
- Scoped commit guard (hotfix): SHIP uses `git add` of approved-scope paths only. Step 1 already records unrelated dirty files as excluded/not-touched; a blanket add/commit would sweep them into the PR. SHIP re-checks `git status --short` against the approved scope before adding.
  - After FIX, during VERIFY, determine the smallest real check that exercises the changed path (repro-after observation plus scoped typecheck/lint as today; authenticated request/browser pass where the bug is behind auth). Repro-after with auth, not a QA deck (that stays `pipeline` Step 9).
  - Reuse the Step 1 intake creds first; ask for a token set only when missing, expired, or lacking scope: what token, what scope/expiry, where to paste. Constraint-6 hygiene extends to it: held in memory, passed via env, never baked into files, never printed in logs, report, or PR body — record only `token: provided (redacted)` or `token: not needed`.
  - Missing/expired/insufficient token bubbles as a single stop-and-report question; never fake the authenticated path, never mock what should be a logged-in pass.
  - Keeps hotfix lightweight: no supervisor, no review loop, no QA deck.
- Activation fusion (stall fix) in `pipeline`:
  - The `piping time` line is a header, never a bare-text turn end. Emit it in the same turn as the first Step 1 action (git state + worktree + supervisor spawn).
  - Stall rule: no user-visible progress within ~2 min of activation → emit the intake block and continue without waiting. Covers the multi-harness scheduler pause regardless of which harness pauses the turn.
- Discovery metadata ships in the same change (or stale text contradicts SHIP): `hotfix` frontmatter description (`never commits, pushes, or merges` → commit/push/ready-PR on current branch, no merge), README orchestration effect cell (`never commits` → commits scoped fix + opens ready PR), plus `CHANGELOG.md`/`VERSION` bump per repo rules.

## Scope

- Modify: `hotfix/SKILL.md` (Step 7 SHIP, VERIFY token check, constraints 1-2 rewrite, scoped-add guard, frontmatter), `pipeline/SKILL.md` (Step 5 ready-PR, Activation fusion + stall rule), `dark-factory/SKILL.md` (Brief + outcome schema ready-PR only), `README.md` (one effect cell), `CHANGELOG.md` + `VERSION`.
- Read-only skills (`pr-review-toolkit`, `architecture-audit`, `topic-research`, `server-maintenance`, audits) get no PR behavior.
- This spec authorizes the skill edits only. REJECT: fix-branch hotfix (breaks never-leave-branch), deleting the activation line (larger behavior change for same outcome), full QA deck inside hotfix (that's `pipeline`).
- Next step is the writing-plans skill for the implementation plan, per the brainstorming terminal state.

## Self-review

- Placeholder scan: none — all gates concrete (scoped `git add`, `gh pr ready` repair, target-branch guard, 2-min stall rule, token redaction).
- Consistency: commit-on-current-branch matches never-leave-branch; ready-PR matches never-draft; dark-factory merge decision untouched; hotfix stays supervisor-free and deck-free.
- Scope: three skills + metadata; no caller migration beyond frontmatter/README/CHANGELOG.
- Ambiguity check: "token set" means the minimal auth value(s) the verification path needs (session cookie / bearer / authed session value), requested once, session-only; "ready PR" means non-draft at SHIP end state, repaired via `gh pr ready` when the repo defaults to drafts.
