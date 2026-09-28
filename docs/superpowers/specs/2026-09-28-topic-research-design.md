# Topic Research — design spec (DRAFT, pending approval)

Date: 2026-09-28. Status: drafted from brainstorming; design sections presented, awaiting user approval.

## Problem
Documentation drifts and custom plans get written for solved problems. The harness needs a
contrarian that checks prior art first and biases toward popular, battle-tested answers.

## Decision
New skill `topic-research`: parallel contrarian inside pipeline party planning + standalone.
Recommendations below follow user answers: always-on in party, assume-provider/ask-only-on-failure,
consensus-first with human quick-check on new additions, hard-signals-first ranking.

## Skill shape
- New dir `topic-research/SKILL.md` in this repo. Frontmatter `name: topic-research`,
  description: `Use when deciding whether prior art, libraries, or battle-tested software already
  solve a task before committing to a custom plan`.
- Self-contained, <500 words, one runnable example brief. README row + same symlinks as pipeline.
- No new harness deps. No code changes outside two small hook edits (below).

## Invocation
- Standalone: any caller gets a ranked prior-art brief, no party required.
- Pipeline Step 2: Round 1 always spawns one topic-research agent (fresh session, search tools on);
  its brief is required input to Round 2 deliberation.
- Dark-factory: inherits per-ticket via pipeline. No factory-level loop; principal only sees a
  bubbled delta question if one arises.
- Skip only when the incoming plan already names its prior-art decision (same bar as "skip planning").

## Search-provider gate
- Assume a provider exists. Try order: `web_search` → browser → docs MCP; first that answers wins.
- If none answers: stop and ask the human for one before proceeding. Never silent-skip, never fabricate.
- Every brief logs queries run + provider used, or `not-run: <reason>`.

## Popularity rubric (hard signals first)
Rank by, in order: downloads/dependents, stars/forks, commit recency + maintainer count, issue/PR
responsiveness, license fit, ecosystem fit (already in repo registry or stdlib-adjacent wins ties).
API elegance never outranks an order-of-magnitude adoption gap.
Verdict per slice: `adopt` (use it) / `adapt` (wrap it) / `build` (nothing battle-tested fits, 1-line why).

## Consensus + human quick-check
- Party Round 2 must accept-or-reject each verdict with a stated reason; consensus table records disposition.
- After consensus, any delta vs intake (new dep, new service, scope deviation) becomes exactly one
  batched supervisor/principal question ("adopt X instead of building Y?"); planning waits for the answer.
- Non-deviating finds ride along advisory in ledger/deck, no page. No auto-adopt, no implementation
  inside the skill.

## Hook edits (implementation phase, not this doc)
- `pipeline/SKILL.md` Step 2: spawn + disposition + ledger line (~10 lines).
- `dark-factory/SKILL.md`: one line — delta questions propagate like other shared questions.
- `README.md`: one table row. Symlink skill into the three harness registries.

## Non-goals
No code changes by the skill, no candidate deep-eval beyond the brief, no review-loop changes,
no factory orchestration changes beyond propagating the one question.

## Verification (skill TDD, implementation phase)
Pressure scenarios before merge: (1) agent must surface the popular incumbent under time pressure
instead of planning custom code; (2) with no provider available, agent must ask, not skip or invent;
(3) agent must not auto-adopt — deviation waits on the human. Baseline (no skill) documented first.
