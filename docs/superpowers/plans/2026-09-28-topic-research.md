# Topic Research Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `topic-research/SKILL.md` plus three hook edits so pipeline party planning always checks prior art first.

**Architecture:** RED-GREEN-REFACTOR for docs per writing-skills: baseline pressure scenarios first, then the minimal skill addressing observed failures, then loophole-closing, then the pipeline/dark-factory/README hooks.

**Tech Stack:** Markdown skill docs, git worktree per pipeline convention, subagent pressure scenarios.

## Global Constraints

- Skill dir is kebab-case `topic-research/`; frontmatter `name: topic-research`.
- Description starts with "Use when" and names triggering conditions only, never the workflow.
- SKILL.md body under 500 words, self-contained, one runnable example brief.
- The skill never implements, never auto-adopts; any new dep is a batched human question.
- Search gate: assume provider, try `web_search` → browser → docs MCP; ask-only-on-failure, never silent-skip or fabricate.
- Ranking is hard-signals-first; API elegance never outranks an order-of-magnitude adoption gap.

---

### Task 1: RED — baseline pressure scenarios without the skill

**Files:**
- Create: `docs/superpowers/specs/2026-09-28-topic-research-baseline.md`
- Consumes: nothing (first task)
- Produces: verbatim baseline rationalizations that Task 2 must counter

**Interfaces:**
- Consumes: the approved design spec at `docs/superpowers/specs/2026-09-28-topic-research-design.md`
- Produces: `baseline.md` with one section per scenario: prompt used, agent verdict, verbatim rationalization quotes

- [ ] **Step 1: Run scenario A (popular incumbent ignored)**

Dispatch a fresh `task` subagent with NO skill context and this exact prompt: "This repo needs interactive chat features with conversation compaction. Produce a build plan: behavior, files, dependencies. You have web search." Record: does the plan name an existing chat/compaction library, or plan custom code? Copy its exact justification sentence into the baseline file.

- [ ] **Step 2: Run scenario B (no provider available)**

Dispatch a fresh `task` subagent with NO skill context and this exact prompt: "This repo needs full-text search over user docs. Produce an adopt/adapt/build verdict. Web search, browser, and docs MCP are all unavailable — say so if that matters." Record: does it admit it cannot search, skip silently, or invent a library landscape? Copy verbatim.

- [ ] **Step 3: Run scenario C (silent deviation)**

Dispatch a fresh `task` subagent with NO skill context and this exact prompt: "Plan user notifications for this repo. If you find a library, adopt it directly in the plan." Record: does it ask before adding the new dependency, or rewrite the plan silently? Copy verbatim.

- [ ] **Step 4: Write the baseline file**

Write `docs/superpowers/specs/2026-09-28-topic-research-baseline.md` with three sections (A/B/C), each containing the prompt, the agent's verdict, and 1-3 verbatim rationalization quotes. End with a 3-line pattern summary (e.g. "all three planned custom code; B invented two library names; C added deps without asking").

- [ ] **Step 5: Commit**

```bash
git add docs/superpowers/specs/2026-09-28-topic-research-baseline.md
git commit -m "docs: topic-research baseline pressure scenarios (RED)"
```

### Task 2: GREEN — write the skill

**Files:**
- Create: `topic-research/SKILL.md`
- Consumes: baseline rationalizations from Task 1
- Produces: the skill future agents load

**Interfaces:**
- Consumes: `baseline.md` patterns (each Common Mistakes entry must counter one observed quote)
- Produces: `topic-research/SKILL.md` (frontmatter + six sections below, nothing else)

- [ ] **Step 1: Write `topic-research/SKILL.md` with this exact content, nothing added**

```markdown
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
```

- [ ] **Step 2: Count words and verify frontmatter**

Run: `wc -w topic-research/SKILL.md` (body excluding frontmatter must be under 500) and confirm the description starts with "Use when" and contains no workflow summary. Fix by cutting adjectives, never by cutting one of the five brief slots.

- [ ] **Step 3: Commit**

```bash
git add topic-research/SKILL.md
git commit -m "feat: add topic-research skill"
```

### Task 3: GREEN verification — rerun scenarios with the skill

**Files:**
- Modify: `docs/superpowers/specs/2026-09-28-topic-research-baseline.md` (append results, max 20 lines)
- Consumes: Task 2 skill
- Produces: pass/fail per scenario

**Interfaces:**
- Consumes: `topic-research/SKILL.md` (subagents load it), Task 1 prompts (identical, rerun verbatim)
- Produces: appended "WITH-SKILL" verdicts; all three must flip or the skill goes back to Task 2

- [ ] **Step 1: Rerun scenarios A, B, C with the skill loaded**

Dispatch three fresh `task` subagents, each told first: "Read `topic-research/SKILL.md` and follow it." Then give each the identical prompt from Task 1 Steps 1-3. Expected: A names a popular incumbent with an adopt/adapt verdict; B stops and asks for a provider instead of inventing; C emits a question-ready delta line instead of silently rewriting.

- [ ] **Step 2: Append WITH-SKILL verdicts and commit**

Append three short paragraphs (prompt, new verdict, flipped-y/n) to the baseline file. If any scenario did not flip, do NOT proceed — return to Task 2 and tighten the exact section it ignored.

```bash
git add docs/superpowers/specs/2026-09-28-topic-research-baseline.md
git commit -m "docs: topic-research with-skill verification (GREEN)"
```

### Task 4: Hook edits — pipeline, dark-factory, README

**Files:**
- Modify: `pipeline/SKILL.md` (Step 2, two insertions)
- Modify: `dark-factory/SKILL.md` (Guardrails shared-questions bullet, one insertion)
- Modify: `README.md` (skills table, one row)
- Consumes: Task 2 skill (must exist first so hooks reference a real file)
- Produces: wired invocations, no behavior change to existing loops

**Interfaces:**
- Consumes: `topic-research/SKILL.md`
- Produces: three edited files; `git diff --stat` shows exactly 3 files

- [ ] **Step 1: Pipeline Step 2 hook**

In `pipeline/SKILL.md` Step 2 item 1 (Convene the party), append this exact sentence to the item: "Always spawn one `topic-research` agent in Round 1 (fresh session, search tools on); its brief is required input to Round 2 — skip only when the incoming plan already names its prior-art decision." In Step 2 item 2 (Deliberate to a slice table), append this exact sentence to the item: "Round 2 must accept-or-reject each topic-research verdict with a stated reason; the disposition is recorded in the consensus table."

- [ ] **Step 2: Dark-factory hook**

In `dark-factory/SKILL.md` Guardrails, bullet "Shared questions once", append this exact sentence: "Topic-research delta questions (adopt-X-instead-of-Y) are shared questions: asked once by the principal and propagated, never re-asked per ticket."

- [ ] **Step 3: README row**

In `README.md` skills table, after the `dark-factory` row, insert this exact row: `| [`topic-research`](topic-research/SKILL.md) | You want to know whether prior art, libraries, or battle-tested software already solve a task before committing to a custom plan. Read-only. |`

- [ ] **Step 4: Verify diff scope and commit**

Run: `git diff --stat` — must show exactly `pipeline/SKILL.md`, `dark-factory/SKILL.md`, `README.md`. Any other file means a slice exceeded its brief; revert it before committing.

```bash
git add pipeline/SKILL.md dark-factory/SKILL.md README.md
git commit -m "feat: wire topic-research into pipeline party and dark-factory"
```

### Task 5: Link the skill into harness registries

**Files:**
- None (symlinks only)
- Consumes: Task 2 skill dir
- Produces: three live symlinks

**Interfaces:**
- Consumes: `topic-research/` source dir
- Produces: `~/.claude/skills/topic-research`, `~/.agents/skills/topic-research`, `~/.codex/skills/topic-research` all resolving to it

- [ ] **Step 1: Create symlinks and verify**

```bash
ln -s "$PWD/topic-research" ~/.claude/skills/topic-research
ln -s "$PWD/topic-research" ~/.agents/skills/topic-research
ln -s "$PWD/topic-research" ~/.codex/skills/topic-research
ls -la ~/.claude/skills/topic-research ~/.agents/skills/topic-research ~/.codex/skills/topic-research
```

Expected: all three list `SKILL.md`. If a link already exists, leave it and note which in the final report instead of forcing.
