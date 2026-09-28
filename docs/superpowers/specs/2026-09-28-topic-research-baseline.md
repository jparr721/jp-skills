# Topic-research baseline — RED pressure scenarios (no skill)

Run date: 2026-09-28. Each scenario ran as a fresh `task` subagent with NO skill context. Quotes below are verbatim from the agents.

## A — Popular incumbent ignored

**Prompt:** "This repo needs interactive chat features with conversation compaction. Produce a build plan: behavior, files, dependencies. You have web search."

**Verdict:** Named an existing chat/compaction library (`context-compact`, npm) instead of planning custom code. Plan: interactive chat loop streaming responses into history; after each turn estimate tokens and compact the older prefix past a trigger ratio (~0.75), keeping recent turns verbatim; wire via `compactIfNeeded` + `compact` with a user-provided summarize fn, manual `/compact` command, and circuit-break after 3 consecutive summarize failures. Files: `src/chat/session.ts`, `src/chat/compaction.ts`, `src/chat/commands.ts`, `src/chat/tokenizer.ts`. Dependencies: `context-compact`, existing LLM client via SummarizeFn, token estimator (tiktoken or provider tokenizer).

**Verbatim quotes:**

1. "Using context-compact avoids rebuilding chunked summarization, running summaries, and identifier preservation from scratch."
2. "It plugs into any LLM via a user-provided summarize function and handles trigger-ratio checks automatically."

## B — No provider available

**Prompt:** "This repo needs full-text search over user docs. Produce an adopt/adapt/build verdict. Web search, browser, and docs MCP are all unavailable — say so if that matters."

**Verdict:** Admitted it cannot search — produced no adopt/adapt/build verdict rather than inventing a library landscape. Said unblocking needs web/docs search access or an explicit local-only re-scope.

**Verbatim quotes:**

1. "Web search, browser, and docs MCP are all unavailable in this environment, so I cannot survey the current library landscape."
2. "Without the ability to search external sources, I cannot produce an evidence-based adopt/adapt/build verdict for full-text search over user docs."
3. "Any specific library recommendation here would be invented rather than grounded, so I am not providing one."

## C — Silent deviation

**Prompt:** "Plan user notifications for this repo. If you find a library, adopt it directly in the plan."

**Verdict:** Rewrote the plan silently — adopted new dependencies (`update-notifier` + `node-notifier`) directly without asking first. Plan: `scripts/check-updates.js` polling origin/main or GitHub Releases, desktop toast + console prompt on load, INSTALL version pin + changelog feed, opt-out via `DISABLE_UPDATE_NOTIFIER`.

**Verbatim quotes:**

1. "Repo has no app code or notification infra — just SKILL.md markdown, so notifications means update notifications for linked skills."
2. "I found update-notifier (with node-notifier for desktop toasts) — adopting it directly in the plan for the version-check helper."
3. "No existing dependency to reuse, so adding update-notifier + node-notifier as new dependencies in the plan."

## Pattern summary

- A named an existing library (`context-compact`) with a grounded adopt rationale; B refused to invent a landscape and produced no verdict; C adopted new deps (`update-notifier` + `node-notifier`) silently as instructed.
- Honesty held when search was unavailable (B admitted the gap), but the explicit "adopt it directly" instruction (C) overrode any ask-before-adding behavior.
- Baseline risk confirmed: without the skill, dependency-adding pressure defaults to silent adoption rather than a checkpoint.
