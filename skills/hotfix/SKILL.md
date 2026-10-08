---
name: hotfix
description: Use when fixing a bug in place on your current branch — stays on the branch you are on, confirms the issue with an opt-in live repro, checks whether the bug pattern is widespread with conditional 1-to-3 issue-spread analysis, then shows a dead-simple plan for approval before fixing every site, verifying with reused session creds, running pr-review-toolkit light review plus a final code-simplifier pass, and getting final approval before shipping a ready PR.
---

# Hotfix

## Overview

Fast, robust, in-place bug fixes on the branch you are already on. The sequence is fixed:
**INTAKE -> CONFIRM -> SPREAD -> PLAN -> FIX -> REVIEW+VERIFY -> SIMPLIFY -> FINAL -> SHIP**.
SPREAD fans out only when triage justifies it; live repro runs only when you opt in.
No phase is skipped otherwise.

`hotfix` is the lightweight sibling of `pipeline`. Reach for `pipeline` when the work is
a feature, a refactor, a migration, an auth change, or anything spanning multiple systems —
it buys worktree isolation, deliberation, review rounds, and QA proof. Reach for `hotfix`
when a bug is small, its scope is knowable, and you want it fixed where you stand.

**Non-negotiable constraints:**

1. **Never leave the current branch.** No worktree, no new branch, no checkout change.
   Confirm with `git branch --show-current` at intake and stay there. SHIP commits on this branch.
2. **Always ship a ready PR, never merge.** After FINAL approval, commit the scoped fix, push, and open the PR ready — never `--draft` (`gh pr ready` in the same step if the repo defaults to drafts). You never merge; the PR owner does. On the target branch itself (e.g. `main`), stop-and-report instead of opening a PR to self.
3. **Never touch files outside the approved scope.** Unrelated dirty files found at
   intake are off-limits; name them in the plan as explicitly excluded.
4. **Never plan off a guess.** The confirm gate pins exact source lines first; without
   a pin, stop and ask.
5. **No silent scope creep.** Anything past the approved scope becomes a follow-up or a
   `pipeline` run, never an inline expansion.
6. **Creds stay session-only.** Live-repro credentials are held in memory and passed via
   env, never baked into files, never printed in logs or the report — record only
   `creds: provided (redacted)`. Never persist them to the skill, spec, or scratch.
   The same hygiene covers the post-fix token set: reuse Step 1 intake creds first; ask only when missing, expired, or lacking scope. Held in memory, passed via env, never in files, logs, report, or PR body — record only `token: provided (redacted)` or `token: not needed`.

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

### Step 6 - REVIEW+VERIFY (pr-review-toolkit light + repro)

1. **Review.** Run the `pr-review-toolkit` light variant once over the scoped diff: one sweep
   agent across all five angles, one combined Level plus Splinter challenge, verdict block
   required. Pass the confirmed pin as the task source. The canonical review, lighter than the
   pipeline full fight: no defense round, no second attempt. A missing verdict block means no
   review happened — re-dispatch, never guess.
2. **Enforce** the verdict: FIX-THEN-SHIP must-fix clears here like any other scoped site;
   BLOCK stops SHIP and hands the work to `pipeline` with the verdict attached.
3. Repro after: show the same observation passing where it failed before.
4. Run typecheck/lint scoped to touched files only. No full suite, no review loop,
   no QA deck. A regression test is added only on request.
5. Report the diff stat, the verdict, plus what was checked-clean, then continue to SIMPLIFY (no handoff — the run ends at the ready PR, not at working-tree edits).
6. Reuse the Step 1 intake creds first for any authenticated check; ask for a token set (what token, what scope/expiry, where to paste) only when missing, expired, or lacking scope. Missing/insufficient token is a single stop-and-report question — never fake the authenticated path. This is repro-after with auth, not a QA deck.

### Step 7 - SIMPLIFY

Final code pass, once. Skip only if the user said "skip the simplify pass"; never runs after BLOCK.

1. Invoke `code-simplifier` with `caller: hotfix`, scope = the approved-scope paths' diff, and the Step 6 gate (scoped typecheck/lint on touched files plus the repro-after observation).
2. It applies only proven-equivalent candidates and reverts any that turn the gate red. Anything bigger is a follow-up, never an inline addition — the approved plan still bounds the diff.
3. No re-review: the light verdict stands, and simplify edits are reported as unreviewed.
4. Log one line, then continue to FINAL: `simplify: applied=<x> dropped=<y> | re-verify: <green | skipped, nothing applied>`.

### Step 8 - FINAL (final approval gate)

Present the completed fix and wait for a one-word go before SHIP. The light review verdict (Step 6) plus the simplify pass (Step 7) are both done at this point — this gate is the last word, not another review round:

```text
verdict:  <APPROVE | FIX-THEN-SHIP with must-fix cleared>
simplify: applied=<x> dropped=<y> | re-verify: <green | skipped, nothing applied>
diff:     <stat + files>
pr:       <what/where/risk/repro as the PR body will carry>
```

BLOCK never reaches here (hands to `pipeline` at Step 6). Anything past the approved scope is still a follow-up, never an inline addition. No go → stop: do not commit, push, or open a PR.

### Step 9 - SHIP

1. Re-check `git status --short` against the approved scope; `git add` approved-scope paths only — unrelated dirty files recorded as excluded at intake are never added.
2. Commit on the current branch (repo's commit convention per `git log --oneline -10`), push (`--set-upstream` when needed).
3. `gh pr create` ready, never `--draft`; body carries what/where/risk/repro + `token: provided (redacted)` or `token: not needed`, never the value. If created draft by repo default, run `gh pr ready` immediately.
4. Guard: on the target branch itself, stop-and-report instead of opening a PR to self.
5. Report the PR URL line with the diff stat and the simplify line. Done means the ready PR exists, not just working-tree edits.

## Common mistakes

- Fixing the first site without spread triage — the copy-paste sibling survives.
- Planning off the symptom description instead of a confirmed pin.
- Touching unrelated dirty files found at intake.
- Baking repro creds into files, logs, or the report instead of `provided (redacted)`.
- Expanding scope mid-fix instead of stopping at the approved plan.
- Ending at working-tree edits without a ready PR — done means the PR URL is reported.
- Skipping the light review because the fix "is obvious" — obvious fixes still verdict.
- Shipping past a BLOCK verdict — BLOCK hands to `pipeline`, never to SHIP.
- Committing, pushing, or opening the PR before FINAL approval — SHIP runs only on go.
- Using SIMPLIFY to widen the fix — it polishes the approved diff only; new sites or refactors are follow-ups.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
