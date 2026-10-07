---
name: code-simplifier
description: Use when a finished, reviewed change should be made as simple as it can be without changing behavior — a single behavior-preserving polish pass over a scoped diff, judged against the repo's own conventions, with each candidate proven equivalent, re-verified, and reverted on red. Final code pass for pipeline and hotfix; also runs standalone on "simplify this".
---

# Code Simplifier

## Outcomes

Every run ends with a result block. No result block means the pass did not happen.

```text
=== SIMPLIFY RESULT ===
scope:      <PR URL | branch range | files>
caller:     <pipeline | hotfix | standalone>
candidates: <n>
applied:    <x> (each: <file:line> <what> <why equivalent>)
dropped:    <y> (each: <file:line> <reason: behavior | out-of-scope | refactor | taste | reverted-red>)
followups:  <ticket ids or none>
re-verify:  <caller gate + result | skipped, nothing applied>
=== END ===
```

This pass answers one question the review did not: is the finished change as simple as it could be? Review asks whether it is correct; it never re-litigates that. No fight, no verdict, no behavior change, no files outside scope.

## When to Use

- `pipeline` Step 7, after the review loop exits on APPROVE — once per pipeline, whole PR diff.
- `hotfix` Step 7, after REVIEW+VERIFY passes — once per hotfix, approved-scope diff.
- Standalone: "simplify this", "clean this up", "polish before I push" — scope per Step 0.
- When NOT to use: before a review verdict (polish never precedes correctness), after a BLOCK verdict, or for a refactor. A change you would want reviewed is not a simplification.

## Step 0 - Scope

1. Caller-supplied scope wins: pipeline passes `git diff origin/<target>...HEAD`, hotfix passes the approved-scope paths.
2. Else named PR → that diff. Else staged plus unstaged. Else `git diff` against the branch base.
3. No changed files → ask for a PR, branch range, or file list. Never default to the whole repository.

In scope: lines the diff adds or changes, plus code in the same files that the diff itself made redundant (a helper it superseded, a branch it made unreachable). Out of scope: anything else, however tempting.

## Step 1 - Standards (derive, never assume)

The bar is the repo's conventions, not taste. Before proposing anything, read:

1. `AGENTS.md` / `CLAUDE.md` / `CONTRIBUTING.md` and every per-directory guide covering scoped files.
2. Lint/format config (`biome.json`, `.eslintrc*`, `ruff.toml`, `rustfmt.toml`, …) — anything a tool already enforces is the tool's job, not a candidate.
3. Two or three nearest neighbors of each scoped file — the existing pattern for the same job is the target shape.
4. Applicable discipline skills — `typescript-best-practices` for `.ts`/`.tsx`.

Where the repo is silent, the tie-breaker is clarity over brevity.

## Step 2 - Sweep

One read-only agent over the scope for a typical diff; for a large diff, file-disjoint agents in parallel, one file set each. Every candidate carries `file:line`, before/after, and an **equivalence claim**: same outputs, side effects and their order, thrown errors, logs/telemetry, and consumer-visible types. No claim, no candidate.

Candidates worth proposing:

- Nesting a guard clause or early return flattens.
- Single-use indirection: wrappers, pass-through params, one-call helpers that only rename.
- Identity transforms: `map(x => x)`, re-spreading, re-wrapping a value already in that shape.
- Duplicated logic inside the diff, or a hand-rolled copy of a helper the repo already has.
- A second convention beside the existing one — the diff's way loses to the repo's.
- Nested ternaries → `if`/`else` chain or `switch`.
- Names that hide what a value is; comments that restate the code; dead code and stale comments the diff left behind.

Never propose (drop on sight):

- Anything changing public/exported signatures, wire formats, error types, or catch/fallback semantics.
- Dense one-liners, clever combinators, or merging separate concerns to save lines.
- Removing an abstraction that names a domain concept, isolates I/O, or is a seam tests use.
- Reformatting, import reordering, or style the formatter/linter owns.
- Edits to untouched code the diff did not make redundant — that is a followup.
- In compiled or hot code, anything adding an allocation, copy, or extra pass.

## Step 3 - Apply

1. Apply surviving candidates, grouped file-disjoint; parallel agents never share a file.
2. One candidate, one coherent edit. Do not bundle, so a red gate can revert exactly the one that broke.
3. Candidates that turn out larger than polish mid-edit → stop, revert that edit, record as followup.

## Step 4 - Re-verify

Use the caller's gate, never a narrower one:

| Caller | Gate |
|--------|------|
| `pipeline` | Step 4b in the recorded `verify-mode` — `local`: full gate; `ci-only`: push plus CI green |
| `hotfix` | Scoped typecheck/lint on touched files plus the repro-after observation from Step 6 |
| standalone | The repo's typecheck, lint, and tests covering the touched files |

Red → revert the offending candidate and drop it as `reverted-red`; never fix forward. Simplification that needs a fix to stay green was not behavior-preserving. Re-run until green with the survivors, then print the result block.

No confirming review round follows: restricting this pass to proven-equivalent edits is what lets the gate stand in for review. Callers state these edits as unreviewed in their reports.

## Common Mistakes

- **Applying a project-agnostic style guide.** The repo's conventions and nearest neighbors are the bar; upstream "prefer `function`", "explicit return types", and similar rules apply only where the repo says so.
- **Fewer lines as the goal.** A dense one-liner that replaced a readable `if` is a regression.
- **Simplifying untouched code because the file was open.** Scope is the diff and what it made redundant.
- **Fixing forward on red.** Revert the candidate; it was not equivalent.
- **Bundling candidates into one edit.** A red gate then cannot isolate the culprit.
- **Calling a refactor a simplification to dodge the review cap.** If it needs review to be safe, it is a followup.
- **Re-reviewing simplify edits.** The gate is the evidence; callers report the edits as unreviewed instead.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
