---
name: ask
description: Discuss and explain the codebase without changing it.
version: 0.1.0
author: Jarred Parr (jparr721), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
disable-model-invocation: true
metadata:
  hermes:
    tags: [codebase, questions, read-only]
    related_skills: []
---

# Ask

Talk about the codebase, not work on it. Invoked bare, reply `ask mode on` and wait for the first question. Stay in this mode across follow-up questions until the user ends it or explicitly requests implementation; then leave this mode and follow the selected editing workflow.

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` through the terminal tool before any dispatch or pane work. Outside Herdr, say so once and continue in-process; recommend installation only if `command -v herdr` also fails. Inside Herdr, read `herdr --skill` before using its CLI. Never inspect or control panes from outside Herdr. Ordinary codebase discussion needs no panes.

## When to Use
- The user invokes `/ask` (OMP: `/skill:ask`) to discuss code, understand behavior, trace a flow, compare approaches, or explore trade-offs without edits.
- Don't use for implementation, automated fixes, a formal audit, or a delivery pipeline unless the user explicitly leaves discussion mode.

## Procedure
1. Answer the actual question conversationally. If the repository or symbol is unclear, use the current workspace and discover it with `search_files` before asking; ask only when ambiguity changes the answer.
2. Ground code claims in `read_file`, definitions and relevant callers. Use read-only Git inspection through `terminal` when history or a diff matters. Read project instructions and manifests before assuming architecture or dependencies; never read credential files.
3. Explain the relevant behavior with concise `path:line` references. Separate observed behavior from inference and label unverified runtime claims. Discuss alternatives or show small illustrative snippets when useful, without applying them.
4. Keep discussion read-only: do not edit files, write plans or reports, install packages, run builds, tests or migrations, start services, create tickets, commit, push, or open PRs. Do not dispatch implementation or load an editing workflow merely because a question sounds like a feature idea. If runtime execution would materially help, explain what remains unknown and get authorization first.
5. Stop when the question is answered. Do not turn the conversation into an implementation plan, approval gate, or unsolicited offer to make changes. Each follow-up remains discussion unless the user explicitly authorizes implementation.

## Pitfalls
- “How would we change this?” asks for an explanation, not permission to edit.
- A plausible symbol name or stale documentation is not evidence of actual code behavior; trace it.
- This is a behavioral mode, not a tool sandbox. Keep existing dirty files unchanged; do not claim technical write protection.

## Verification
Every factual code claim is supported by inspected sources or clearly labeled uncertain. No codebase or external-system changes were made as part of the discussion, and the reply answers the question without inventing execution results.

## Framework tail
When the user ends the mode, read `../cleanup/SKILL.md` (fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it once. That shared housekeeping hook may synchronize existing private ledgers; it does not authorize codebase edits or new discussion records.
