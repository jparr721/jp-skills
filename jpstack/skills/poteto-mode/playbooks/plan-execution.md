### Plan execution

**The plan is the contract. You own its execution, not its redesign.** Run a written plan task by task with poteto-mode rigor: a `superpowers:writing-plans` plan, a **Multi-phase plan** file, or a `jp-pipeline` slice table.

1. Read the plan in full. Restate its goal and the smallest change that meets it. Check that every task names its files, its data shape, and its check. When the plan is missing or names none of these, stop executing. Write one with `superpowers:writing-plans` when installed, else run **Multi-phase plan**, then come back. When only some tasks have gaps, fill each gap for that task alone: trace the subsystem, then `architect` the shape for a task that crosses a function boundary. Do not re-plan settled tasks.
2. Write the throughput checkpoint from the plan's tasks, as in **Feature** step 3. Group tasks into waves whose write sets are disjoint. One shared file puts two tasks in different waves. Shared foundations (schemas, types, migrations) land alone in the first wave.
3. Give each task to a fresh `poteto-agent` using your configured feature model (default `claude-opus-5-5-xhigh-fast`), or the bug-fix, perf-issue, or refactoring line when the task is that kind. The kickoff holds the worker.md line, the plan's text for that task verbatim, its exact files with "write only these", the named data shape, the task's check, and the worktree's absolute path. Send a whole wave in one message.
4. Review each returned diff yourself against the task's text. Run the task's check on the real surface (**principle-prove-it-works**), then commit that task alone (**principle-sequence-verifiable-units**). Tick the plan's checkbox only after its evidence exists. A red check goes to a fresh delegate with the original brief, the failure, and the prior report.
5. When the plan is wrong, say so in the plan. Add a dated note under the task saying what was wrong, the evidence, and the change, then execute the corrected task. Two tasks failing on one premise means **principle-attack-the-premise** before a third attempt. Never diverge silently, and never widen scope past the plan without a note.
6. Between waves, confirm `git status --short` shows only the wave's declared files. Inspect any stray file before the next wave.
7. After the last task, run **no-comments** over the whole diff and rerun every task's check once at the final head.
8. Hand back. Inside `jp-pipeline`, return to its verify step with the commit list and plan-deviation notes. Open no PR, because the pipeline owns review and landing. Standalone, run **Opening a PR**.

**Reply:** the plan path, each task with its commit and check result, every plan deviation with its evidence, and what stays unproven.
