# Workflow policy

This is the authority for workflow scope, task crew and review inheritance. Resolve it through the installed `jp-pipeline` skill's `references/workflow-policy.md`, or `$JP_SKILLS_REPO/skills/jp-pipeline/references/workflow-policy.md`. A sibling-relative `../jp-pipeline` path is not reliable when skills are independently symlinked.

## Scope and crew

`jp-startup` manages an open-ended queue; `jp-dark-factory` runs one fixed queue; `jp-pipeline` delivers one task; `jp-hotfix` fixes a small bug in place. A broader workflow may delegate to a narrower one, but none requires Startup or a particular terminal. Factory follow-ups remain outside its frozen queue.

For a factory or pipeline, the initiating coordinator spawns a task crew: a manager/coordinator, architect, one or more developers and QA. The coordinator owns dispatch, the ledger, questions and publication; the architect owns technical decomposition and coordination; developers implement; QA independently proves the result. Add PA or DevOps only when needed. A factory's crew coordinates the fixed queue and ticket pipeline crews perform ticket work. In a nested workflow, reuse already assigned, available crew members when their authority and scope cover the work; otherwise spawn the missing roles. Do not duplicate a role merely because a nested skill starts. Startup's admitted employees and their runtime authority stay under Startup's own procedures; local task helpers are not Startup employees. A hotfix is a narrow path and does not spawn the full crew.

## Review budget and inheritance

A review round is one completed code-review pass with its verdict; reviewer angles, batches and debate inside that pass are not additional rounds. Count all rounds touching the same change across nested workflows against one shared per-change ledger. Record scope, head, verdict, consumed rounds and cap at each handoff; a nested workflow never resets or adds a budget. An incomplete attempt without a verdict is not credited, and must be completed before the gate advances.

The outer scope sets the cap, bounded by the nested workflow's own cap when it independently reviews that change: hotfix one; pipeline at most two; dark-factory at most three; Startup's manager chooses a cap at most three and passes it down. A stricter inherited cap always wins. Select the cap before review, do at least one applicable review, and stop on the first APPROVE; there is no minimum number of repeat rounds. A factory may defer ticket pipeline reviews to cross-queue review; each round consumes one for each change it covers. QA, planning debates and the owning Startup architect's architecture gate are distinct from code-review rounds, not a way to relabel another code-review pass.

Fix and verify actionable must-fixes. If a further review fits the remaining budget, review the updated change; otherwise report the post-review fix as unreviewed and stop if an unresolved finding or required approval remains. Never manufacture an APPROVE for an unreviewed revision. A BLOCK escalates; a genuinely false positive requires an evidenced disposition. Any simplification after the final review is explicitly reported as unreviewed and verified under the caller's gate. Review skills must honor the inherited cap, not demand an extra pass.
