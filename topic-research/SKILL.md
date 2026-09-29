---
name: topic-research
description: Use when deciding whether prior art, libraries, or battle-tested software already solve a task before committing to a custom plan, or when a plan should be challenged against what already exists
---

# Topic Research

## Overview
Documentation drifts; solved problems get rebuilt. Check prior art before committing to custom implementation, biasing hard toward popular, battle-tested answers.

## When to Use
- Planning any task where a library, tool, or well-studied pattern might exist (chat, compaction, auth, search, queues — assume prior art exists until proven otherwise).
- As the pipeline Step 2 Round 1 contrarian (always-on; skip only when the incoming plan already names its prior-art decision).
- Standalone when asked "is there a library for X" or for an adopt/adapt/build verdict.
- When NOT to use: repo-specific plumbing with no external analogue; a plan that already records its adopt/adapt/build verdict.

## Search-provider gate
Assume a provider exists. Try in order: `web_search` → browser → docs MCP; first that answers wins. If none answers, STOP and ask the human for one before proceeding. Never silent-skip, never fabricate. Log queries plus provider used in the brief, or `not-run: <reason>`.

## Core pattern: the brief
One page, five slots, in this order:
1. Candidates (max 3): name, version, license, downloads/dependents, stars/forks, last commit plus maintainer count, issue/PR responsiveness.
2. Ranking, hard signals first: downloads/dependents, then stars/forks, recency plus maintainers, responsiveness, license fit, ecosystem fit (already in the repo registry or stdlib-adjacent wins ties). API elegance never outranks an order-of-magnitude adoption gap.
3. Verdict per slice: `adopt` (use it) / `adapt` (wrap it) / `build` (nothing battle-tested fits, one line why).
4. Deviation deltas: anything the verdict adds versus intake (new dep, service, scope change), one question-ready line each.
5. Queries run plus per-candidate confidence (high/medium/low).

## Human quick-check
After party consensus, each deviation delta becomes exactly one batched supervisor/principal question ("adopt X instead of building Y?"); planning waits for the answer. Non-deviating finds ride advisory in the ledger/deck. Never auto-adopt, never implement inside this skill.

## Common mistakes
- Rubber-stamping "no prior art found" after one query — run at least 3 distinct queries (name variants, ecosystem registry, "awesome-X" lists).
- Ranking by API elegance over adoption — the boring popular answer wins ties and most non-ties; that bias is the point.
- Adapting the plan silently — any new dep is a human question, not an inline edit.
- Searching after consensus instead of during Round 1 — late findings cause rework; the brief is required input to Round 2.

## Worked example (compaction slice)
1. Candidates: `context-compact` (npm, MIT, 41k weekly downloads, 1.2k stars, commit 3d ago, 4 maintainers, issues answered within 7d).
2. Ranking: order-of-magnitude adoption lead, license fits, adjacent to the repo toolchain.
3. Verdict: adapt — wrap `context-compact` behind the repo session interface.
4. Delta: "+ `context-compact` dependency — adopt instead of building a compactor?"
5. Queries: "conversation compaction library", "npm context-compact", "awesome llm compaction"; confidence high.

## Framework tail
Before finishing, read `../shared/cleanup.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/shared/cleanup.md`) and follow it.
