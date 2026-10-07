---
name: pr-review-toolkit
description: Use when reviewing recent code changes, a pull request, or a git diff for a ship verdict — adversarial review from five angles with a club fight producing APPROVE / FIX-THEN-SHIP / BLOCK plus must-fix list. Canonical review for pipeline, dark-factory, hotfix.
---

# PR Review Toolkit

## Outcomes

Every run ends with a ship verdict. No verdict block means the review did not happen.

```text
=== REVIEW VERDICT ===
scope:      <PR URL | branch range | files>
variant:    <full | light>
verdict:    APPROVE | FIX-THEN-SHIP | BLOCK
must-fix:   <n> | none (each: <file:line> <claim> <proof> <fix>)
followups:  <ticket ids or none>
dissent:    <<=2 lines per item or none>
residual risk: <one line>
=== END ===
```

Verdict meanings:

- **APPROVE** — zero must-fix. Suggestions and followups never block. The caller may ship once its own gates pass (pipeline still needs round count plus verify/CI).
- **FIX-THEN-SHIP** — must-fix list non-empty. Fix each item, re-verify, re-review. Nothing ships past an open must-fix.
- **BLOCK** — the implementation is wrong against its task or plan, needs a design change, or a finding invalidates the approach. Line fixes are the wrong tool: escalate (pipeline stops via supervisor, hotfix hands to pipeline).

Finding ranks:

- **must-fix** — proven ship risk: breaks users, loses data, opens a security hole, fails silently, leaves a risky path unproven, or shapes code so the next change hides a breaker. Every must-fix carries file and line, proof (trace, exploit, or named missing case), user impact, and concrete fix. No proof means no must-fix.
- **suggestion** — behavior-preserving polish. Never blocks, never re-reviewed.
- **followup** — real but out of scope. Becomes a ticket id, never an inline expansion.
- **waived / dissent** — every dropped finding logs its reason; unresolved disagreement logs at most 2 lines per item under dissent.

Completion criterion: the verdict block is printed, every must-fix has location plus proof plus fix, and every dropped finding has a reason or a dissent entry.

## When to Use

- Before commit, PR, merge, or after review feedback — full fight.
- After FIX in hotfix — light variant, one round, verdict still required.
- Inside pipeline Step 6 (full fight per review round).
- Against a design sketch in architect Phase C — fight protocol with scope set to the sketch.

## Canonical Callers

- `pipeline` Step 6 runs the full fight every review round; the verdict drives enforce, terminate, and merge. Polish after APPROVE belongs to `code-simplifier` (pipeline and hotfix Step 7), never to this skill.
- `dark-factory` never calls this skill directly. Per-ticket verdicts arrive inside pipeline outcome blocks.
- `hotfix` runs the light variant once after FIX. BLOCK stops SHIP and escalates to pipeline.
- `architect` Phase C may run the fight protocol against the synthesized sketch before implementing.

## Step 0 - Scope

Resolve scope before dispatching angles:

1. Named PR → that PR diff.
2. Else staged changes → staged plus unstaged unless the user says otherwise.
3. Else `git diff` against working tree or branch base. Pipeline rounds review the pushed diff, never a stale local one.
4. No changed files → ask for PR, branch, commit range, or file list.

Resolve the task source alongside scope: Linear ticket acceptance, pipeline consensus slices, or hotfix confirmed pin. The spec angle prosecutes against it; without a task source that angle checks scope-consistency only. Record both in every angle prompt.

Useful commands when available:

- `git status --short`
- `git diff --name-only`
- `git diff --cached --name-only`
- `gh pr view --json number,title,headRefName,baseRefName,files` for an existing PR

## Step 1 - Angles (party, parallel)

Dispatch one read-only agent per applicable angle as fresh sessions with no shared memory, all in parallel. Each prompt carries the scope, the task source, and this contract: return findings only for this scope with file and line each; every finding needs claim, proof, user impact, and concrete fix; no proof means no finding; never modify files.

| Angle | Covers | Must prove |
|-------|--------|------------|
| `spec` | Task and acceptance match; missing or extra behavior | Which acceptance fails or contradicts, traced to the diff |
| `breaker` | Bugs, races, security holes, invalid states, type invariants that compile but fail in prod | Exploit or trace to breakage plus user impact |
| `failure` | Catches, fallbacks, retries, null and optional paths, external calls, user feedback, debug context | The hidden error plus its user impact |
| `proof` | Tests and verification evidence | Which breaker or failure finding the proof would miss, and the missing edge, negative, async, or boundary case |
| `shape` | Types, names, structure, comments — ship-relevant only: what breaks the next change or hides a breaker | How the next change breaks or which breaker it conceals |

Angle briefs:

- **spec** — Check the diff against the task source. Name each acceptance the diff misses or contradicts, with a trace. Flag extra behavior as followup candidates, never must-fix.
- **breaker** — Break it. Hunt bugs, races, security holes, invalid states, and invariants that compile but fail in prod. Each finding needs an exploit or trace plus user impact.
- **failure** — Fail it. Walk every catch, fallback, retry, null path, and external call. Each finding names the hidden error and its user impact.
- **proof** — Attack the proof. For each risky path, would the added or changed tests catch the breaker and failure findings? Name the missing case and which finding it would have caught.
- **shape** — Ship-relevant shape only. Flag types, names, structure, or comments that will break the next change or hide a breaker. Pure polish is not must-fix; note it for `code-simplifier`.

Default is all five angles for a comprehensive review. Targeted reviews run the requested subset, and the verdict block notes the narrowed scope. Pure polish requests go straight to `code-simplifier`, never through the fight.

## Step 2 - Fight (club, max 2 debate rounds)

The club attacks the merged findings. Roles mirror the pipeline party's Anti-Consensus Club minus Wildcard, which proposes problems rather than judging claims:

- **Level** — claim checker. Is each proof real? Where are the support gaps? Drop speculation on sight.
- **Splinter** — consensus challenger. Which easy agreement did the angles skip, which tradeoff got ignored, which angle has a blind spot here?
- **Killjoy** — stop rule, not a persona. Two debate rounds exist; a third never does. Repetition, fake disagreement, and unsupported speculation die immediately.

Protocol:

1. Round 1: angles propose in parallel (Step 1).
2. Merge: deduplicate overlaps, preserve the finding angle on each survivor.
3. Club attacks the merged list: Level checks every proof, Splinter challenges consensus and coverage.
4. Round 2: angle owners defend with stronger proof or concede. Exactly one defense round.
5. Keep rule: a finding becomes must-fix only with its proof standing and the club challenge survived. Everything else drops to suggestion, followup, waived with reason, or dissent.

A finding that would need a third round is either must-fix on standing proof or dropped for lacking it. Stalemate is dissent, not a further round.

## Step 3 - Verdict

Map the survivors:

1. Any survivor invalidating the approach or design → BLOCK. Log surviving must-fix items anyway, then escalate instead of fixing lines.
2. Else any must-fix → FIX-THEN-SHIP with the full list.
3. Else → APPROVE.

Print the verdict block first, then the human report: must-fix items with impact and fix, suggestions, followups, dissent, residual risk, and the scope log (angles run, skipped with reasons, debate rounds used).

## Light Variant (hotfix)

One sweep agent covering all five angles in a single pass, then one combined Level plus Splinter challenge, then the verdict. No defense round: the coordinator keeps only proven findings and verdicts. Same verdict block with `variant: light`. BLOCK hands the work to pipeline; FIX-THEN-SHIP clears inside hotfix VERIFY.

## Quick Reference

| User Request | Form |
|--------------|------|
| "Review this PR" | Full fight, all five angles, verdict |
| "Check tests" | Proof angle plus whoever owns the risky paths, club, verdict (narrowed scope noted) |
| "Review error handling" | Failure angle plus breaker, club, verdict (narrowed scope noted) |
| "Check comments/docs" | Shape angle, club, verdict (narrowed scope noted) |
| "Review these types" | Shape plus breaker, club, verdict (narrowed scope noted) |
| "Code review before commit" | Full fight, all five angles, verdict |
| "Simplify this" | Not this skill — run `code-simplifier` |
| Hotfix after FIX | Light variant, verdict required |

## Common Mistakes

- **One generic reviewer instead of party plus club.** The fight is the value: single-pass review keeps false positives and misses real breakage.
- **Findings without proof.** Unproven claims are speculation for Level to drop, not items to debate.
- **Polishing before the verdict.** `code-simplifier` runs after APPROVE, never inside the fight.
- **Reviewing the whole repository by default.** Scope is the diff unless the user asks broader.
- **Treating suggestions as must-fix.** Taste never blocks shipping; proven breakage never ships as taste.
- **Answering BLOCK with line fixes.** BLOCK means the design is wrong: escalate.
- **Skipping the test lens because tests exist.** Existing tests can still miss exactly the behavior that changed.
- **Skipping failure review because code compiles.** Silent failures are behavioral bugs, not type errors.

## Framework tail
Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
