---
name: startup-intake
description: Intake protocol — feasibility/doability triage for prompts, Linear ids, and screenshot complaints; writes per-item repo/remote/target/merge-strategy rows to queue.json; only enqueue, async-clarify, or reject-with-reason.
---

# Startup intake

Repeatable front door for the queue. Every prompt, Linear id, or screenshot complaint passes feasibility/doability triage before it becomes a `queue.json` row. Dispatched from `skill://startup`; rows consumed by `skill://startup-role-manager`.

## Queue-worthy criteria

An item is queue-worthy when it meets one path:

- **Linear id** (e.g. `SYT-xxx`): fetch the ticket; acceptance criteria come from the ticket.
- **Prompt**: must name the behavior + affected area + acceptance (what done looks like). Vague prompts fail triage, not the worker.
- **Screenshot + complaint**: not intake — route to the `stop-doing` interpret path (see `skill://startup-stop-doing`): mesh QA + architect to derive repro, scope, rule.

Feasibility check: repo exists and is reachable, target is known, merge strategy follows that repo's convention. Doability check: acceptance is testable within one pipeline run.

## Per-item record

Each enqueued item is one row in `<home>/startup/queue.json` (home chain: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`; NEVER `tmp/`) with exactly:

`id, source, status, repo, remote, target, merge-strategy, branch, worktree, report-handle`

`merge-strategy: squash|merge per repo convention` — record the repo's convention at intake; the manager merges with it. `branch`/`worktree` are assigned at dispatch; `report-handle` at outcome.

## Triage outcomes only

Three outcomes, no fourth:

- **enqueue** — criteria met; write the row, confirm in one line.
- **async-clarify** — near-miss; park the item, ask the boss in one batched message, proceed with the rest of the queue.
- **reject-with-reason** — fails feasibility/doability; one line: what was asked, why it fails, what would make it queue-worthy.

No criteria met and no clarifiable shape → one line back to the boss, nothing written. Never enqueue a placeholder row to "fill in later".

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
