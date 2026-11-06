---
name: jp-quickfix
description: Use for small fixes that should be shipped quickly with minimal coordination.
disable-model-invocation: true
---

# Quickfix


The user steers a run of small changes across one-off spots. Each request is the plan. Quickfix is the whole process for every request until the user ends the mode; invoked bare, reply `quickfix on` and wait for the first request.

`jp-hotfix` is the reviewed sibling. Quickfix keeps the change small and ships it through CI and a PR without an approval prompt.

## Here

Use a task branch or isolated worktree from the target. Preserve unrelated dirty changes, including changes in files this task touches; do not stage another person's work.

## Blockers

Ask only when a blocker stops the edit: a fact the code cannot supply and the answer changes what gets written (two plausible targets, an undecided value or behavior). Finish every edit a blocker does not touch first, then batch all blockers into one message, each with a recommended default so one word unblocks. Everything else - which file, naming, conventions, how to verify - settle from the code and proceed.

## Loop

1. **Locate.** Read the code the request names, then its callers and nearest neighbors, until you can name the exact edit site (for a bug, the root cause) and the helper, type, or pattern the repo already has for it.
2. **Edit at the root.** Make the change where it covers every case, reusing what the repo already has. When the edit would duplicate existing logic, extract the shared piece and point the sites the request names at it. Sibling copies of the same defect that the root fix leaves untouched go in the report as `file:line` for the user to call.
3. **Check.** Run the cheapest check that exercises the change: the focused test, scoped typecheck or lint. Red caused by the edit: fix and re-run. Red that predates it, including the user's in-flight changes: report it with its output for the user to call. No check reaches the change: report it as unchecked.
4. **Ship.** Commit scoped changes, open a ready PR, follow CI and fix failures. Merge by default using the repository convention and an exact-head guard; honor a user request not to merge. Read back the PR and target commit, then follow applicable post-merge verification. Report the PR and actual check results.

## Framework tail

When the user ends the mode, read `../jp-cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/jp-cleanup/SKILL.md`) and follow it, once.
