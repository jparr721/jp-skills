---
name: filing-agent-tasks
description: Use when filing or refining tasks for agent execution.
version: 0.1.0
author: Jarred Parr (jparr721), Hermes Agent
license: MIT
platforms: [linux, macos, windows]
---

# Filing agent tasks

## Herdr preflight
Inspect `HERDR_ENV` through the terminal tool using the host's native environment mechanism before dispatch or pane work. If its value is not `1`, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (https://herdr.dev/docs/install/), then continue in-process. If it is `1`, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

Turn requests and existing tickets into researched, self-contained execution contracts. A populated template is not evidence of readiness. The next agent must be able to start without rediscovering requirements, choosing product policy, or reconstructing this conversation. This skill prepares work; it does not implement it or authorize deployment.

This is a procedural gate when the skill is loaded, not a runtime guard, tracker hook or automatic follow-up scheduler. Do not claim globally enforced readiness or automatic dispatch interception. Offline contract tests protect these instructions, not agent compliance.

## When to Use

- Filing tickets, refining a backlog, preparing an epic's children, or checking whether existing tasks are truly ready for agents.
- Invoke as `/filing-agent-tasks <request, ticket IDs, or epic>` (OMP: `/skill:filing-agent-tasks ...`).
- Not for status-only updates or implementation. Existing orchestration ownership still applies: route questions through the designated manager, not around it.

## Prerequisites

Use the user's selected tracker connection; for this user, use Composio for Linear, never direct Linear MCP. Discover available operations and inspect their schemas rather than inventing API fields or status names. Confirm workspace/project/team and read/write access. Access failures are blockers, not permission to switch providers. Never read credential files or paste secrets into tasks.

## Procedure

1. **Capture the complete work set.** Read the full request, attachments, ticket descriptions and paginated comments, parent/child issues, dependencies and linked specs. Search for duplicates and prior decisions before creating anything. Preserve exact identifiers and explicit constraints; validate malformed IDs instead of silently repairing them. Enumerate every requested deliverable. For batches, keep a durable per-item ledger and reconcile requested versus processed IDs programmatically; do not refine one ticket and call the epic ready. Completion: each deliverable maps to an existing or proposed task with an intended destination.

2. **Research before drafting.** Use `search_files` and `read_file` to inspect repo instructions, manifests, entry points, definitions, callers, adjacent implementations, tests and CI. Trace the affected behavior across service/repo boundaries; naming a plausible file is not a trace. For bugs, record observed versus expected behavior, a minimal repro and supporting logs/tests; distinguish a suspected cause from a demonstrated one. Use authoritative docs or web research when external contracts or versions matter. For non-code work, inspect its actual target, governing documents and verification surface. Record source permalinks or revision-qualified `path:line` evidence and what each source establishes. Completion: every material factual claim has evidence, or is explicitly an unresolved question.

3. **Close the question ledger.** Write each material question with its answer, source or decision-maker, and disposition: `resolved`, `blocking`, or `non-blocking`. Probe scope, intended users, inputs/outputs, error/empty states, permissions, data ownership, compatibility, dependencies, rollout and proof; use the template prompts, not boilerplate answers. Resolve retrievable questions yourself. A consequential assumption is a question, not an answer: never invent product behavior, access, numeric targets or approval. Choose routine implementation details only within existing authority, explain why, and leave nonessential internals to the implementer. Batch remaining independent questions to the user/manager with a recommendation and the execution consequence of each answer. Persist answers into the canonical task, not only chat or comments. Completion: every execution-blocking question is answered or visibly blocks readiness; non-blocking items state why work can proceed and who owns the follow-up.

   Before pausing for answers, save the researched draft and question ledger with a not-ready verdict, applying Step 7's conflict protection and readback even to partial updates. If no safe tracker write is possible, preserve an authorized local draft and report its path, unsaved tracker state and missing decision owners. Do not pause with the only record in chat. On resumption, read the current task and answers before continuing; do not treat a proposed recommendation as approval.

4. **Write the execution contract.** Fill `templates/task.md`, adapting detail to the task rather than deleting hard questions. Keep the canonical description self-contained; supporting comments and links supplement it, never replace requirements. Include specific in/out scope, constraints, grounded starting points, dependency outputs, observable acceptance criteria and a criterion-to-verification map. Commands must come from inspected repo recipes; label proposed tests and unexecuted commands honestly. For docs/research/ops, specify equivalent deliverables and independent proof instead of forcing a code-test template. Use `not applicable — <reason>` only where genuinely irrelevant. Completion: every requirement maps to acceptance and proof; no placeholder or unsupported assertion is presented as settled.

5. **Split and wire executable units.** Separate independent deliverables and preparatory investigations when they have different owners, repos or prerequisites. Each child needs its own complete contract; an epic's paragraph is not a child specification. Record dependency IDs, direction, the exact output consumed and the condition that unblocks work. Dependencies must be satisfied before execution readiness; do not label a child ready merely because its prerequisite has a ticket. A research spike may be ready to answer a bounded question while the implementation task stays blocked. Preserve original scope and link deferred work; do not silently discard requirements. Completion: no circular ordering, orphan deliverable or hidden prerequisite remains.

6. **Run the cold-start challenge.** Review the final draft as an agent with only the ticket, its cited sources and normal repo access. Ask: where do I start; what changes and what must not; which decisions are settled; what can fail; how do I prove completion; what allows rollout? Try to find two plausible incompatible implementations that both pass its wording. If they differ on required behavior, close that ambiguity; legitimate internal choices need not be prescribed. For multi-repo, security-sensitive or otherwise substantial work, use an independent read-only reviewer when available, supplying the full draft and sources without hidden chat context. Reviewer findings must identify concrete unanswered questions, not award a completeness score. If unavailable, perform the same adversarial pass yourself and disclose that limitation. Revise and repeat until no execution-blocking gap remains, or record the blocker. Completion: every review finding is resolved in the task or contributes to a not-ready verdict.

7. **Persist, read back, then gate readiness.** Re-fetch the target before updating; preserve unrelated edits, human decisions and metadata. Require the tracker's revision/conflict protection or serialized/exclusive editing coordinated with other writers before replacing an existing description. A fresh-read/merge/write alone leaves a lost-update race; readback cannot prove a concurrent edit was preserved. If neither protection is available, stop the replacement, disclose the race and obtain editing coordination; keep an authorized local draft instead. With protection established, merge deliberately and update the canonical description and explicitly authorized metadata; never overwrite an entire ticket from a stale snapshot. Re-fetch the exact saved task, including full text and relations, and re-run the readiness gate below against the stored result. Check dependency direction and actual workflow state, not just the write response. Only then move it to an existing authorized ready state if requested; read that state back too. Never invent labels/statuses, auto-assign people, change priority or dispatch implementation implicitly. Completion: the live ticket matches the reviewed contract, or the report says saving/verification failed and readiness is unverified.

## Readiness gate

Use one verdict per task, never an average score:

- **READY**: researched contract saved and read back; complete scope and observable acceptance; verification path for every criterion; zero unresolved execution-blocking questions; required decisions/access/prerequisites satisfied; cold-start review findings closed. Proposed tests need not already pass: this is readiness to implement, not proof implementation is complete.
- **NEEDS_INPUT**: a named human decision or authorization is missing. Record the exact question, decision owner, recommendation, affected criteria and unblock condition in the task.
- **BLOCKED**: missing access, evidence, reproducibility essential to the fix, environment or dependency output prevents execution. Record the blocker, owner if known (otherwise explicitly unassigned), next action and unblock condition. Multiple blocker categories may coexist; list all, rather than hiding one behind the primary verdict.
- **DRAFT**: research, writing, review or save/readback is incomplete. A local draft or successful write without readback cannot be READY. If tracker access is unavailable, preserve a clearly marked draft in an authorized local artifact and report that it is not filed.

Readiness is evaluated against cited revisions and dependency state, not forever. On changed scope, material new comments, source drift or a changed prerequisite, reopen affected questions and rerun the gate before dispatch. Do not regress an in-progress/completed ticket's workflow state without explicit authorization; report the contract gap instead. A blocked outcome is a valid result of refinement, not permission to manufacture answers.

## Pitfalls

- Length is not specificity. Reject `handle edge cases`, `add tests`, `works correctly`, `TBD`, `TBC`, `TODO`, unchecked decisions and unexplained `N/A` where they substitute for requirements. Quoted source text or literal fixtures containing those tokens are not automatically gaps.
- Links alone are not answers. Summarize the relevant decision and cite its source; inaccessible links cannot carry essential requirements.
- Implementation hints are not acceptance criteria, and a guessed root cause must not be prescribed as fact.
- Do not leave unresolved feedback in comments and call the old description ready. Incorporate authoritative answers, resolve contradictions explicitly and rerun review.
- Do not claim checks ran, permissions work or dependencies landed without evidence. Research read-only by default; get authorization before reproductions that write data, installs, migrations or live-system actions.

## Verification and handoff

Return a concise per-task receipt: exact ID/URL (or local draft path), readiness verdict, important decisions resolved, outstanding blockers with owners and next actions, source revision reviewed and readback result. Distinguish the readiness verdict in the description from the actual tracker workflow state. For batches, include every requested item and verified counts by verdict; never imply the whole batch is ready while any child is blocked or unprocessed. If waiting for answers, keep the question ledger durable and resume this procedure when answers arrive; do not leave research or follow-up as an untracked promise.

## Framework tail

Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
