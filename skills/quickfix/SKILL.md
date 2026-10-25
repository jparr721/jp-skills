---
name: quickfix
description: Fix-it-now mode - edit in place on the current branch, ask only when blocked, keep the code clean. Hotfix without the gates or the PR.
disable-model-invocation: true
---

# Quickfix

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

The user steers a run of small changes across one-off spots. Each request is the plan and the user reviews the diff. Quickfix is the whole process for every request until the user ends the mode; invoked bare, reply `quickfix on` and wait for the first request.

`hotfix` is the gated sibling (plan approval, review, PR). Quickfix skips the gates and keeps the bar: every edit lands as code a reviewer would approve unchanged.

## Here

The checked-out branch and working tree, as they stand, are the workspace. Every request belongs on that branch, whatever its size or relation to the branch's purpose. Edit beside whatever is already dirty: dirty files the request does not touch stay as they are, and the user edits alongside you, so re-read each file right before editing it.

## Blockers

Ask only when a blocker stops the edit: a fact the code cannot supply and the answer changes what gets written (two plausible targets, an undecided value or behavior). Finish every edit a blocker does not touch first, then batch all blockers into one message, each with a recommended default so one word unblocks. Everything else - which file, naming, conventions, how to verify - settle from the code and proceed.

## Loop

1. **Locate.** Read the code the request names, then its callers and nearest neighbors, until you can name the exact edit site (for a bug, the root cause) and the helper, type, or pattern the repo already has for it.
2. **Edit at the root.** Make the change where it covers every case, reusing what the repo already has. When the edit would duplicate existing logic, extract the shared piece and point the sites the request names at it. Sibling copies of the same defect that the root fix leaves untouched go in the report as `file:line` for the user to call.
3. **Check.** Run the cheapest check that exercises the change: the focused test, scoped typecheck or lint. Red caused by the edit: fix and re-run. Red that predates it, including the user's in-flight changes: report it with its output for the user to call. No check reaches the change: report it as unchecked.
4. **Report.** Line 1: what changed. Then `file:line` per edit, the check result, and any sibling sites or pre-existing red. Edits stay uncommitted in the working tree.

## Framework tail

When the user ends the mode, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it, once.
