# Agent Harness Portability Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make this skill collection portable across Claude, OpenCode, and Codex while preserving one source of truth.

**Architecture:** Keep every skill in its current directory and edit only wording that binds instructions to one harness. Keep harness-specific registry paths in README installation docs. Link global registries with symlinks back to this repo.

**Tech Stack:** Markdown skill files, README documentation, POSIX symlinks, git.

## Global Constraints

- Do not change audit criteria, output schemas, or dark-factory workflow semantics.
- Do not introduce install scripts.
- Do not overwrite existing registry entries that point somewhere else.
- Keep skill bodies action-oriented and harness-neutral.
- Domain tools such as Linear MCP, GitHub CLI, `gh`, and `pr-review-toolkit` may stay named.

---

## File Structure

- Modify: `README.md` - describe the repo as portable agent skills and document Claude, OpenCode, and Codex linking.
- Modify: `architecture-audit/SKILL.md` - replace harness-specific agent and question-tool references with generic actions.
- Modify: `nextjs-code-quality-audit/SKILL.md` - replace `Agent tool` phrasing.
- Modify: `elysia-code-quality-audit/SKILL.md` - replace `Agent tool` phrasing.
- Modify: `vite-tauri-code-quality-audit/SKILL.md` - replace `Agent tool` phrasing.
- Modify: `dark-factory/SKILL.md` - keep workflow semantics, but remove harness-specific model/tool dependency phrasing.
- External links: create symlinks in `~/.agents/skills/` and `~/.codex/skills/` for each repo skill.

### Task 1: Portable Skill Wording And README Docs

**Files:**
- Modify: `README.md`
- Modify: `architecture-audit/SKILL.md`
- Modify: `nextjs-code-quality-audit/SKILL.md`
- Modify: `elysia-code-quality-audit/SKILL.md`
- Modify: `vite-tauri-code-quality-audit/SKILL.md`
- Modify: `dark-factory/SKILL.md`

**Interfaces:**
- Consumes: Existing skill directories and `SKILL.md` frontmatter.
- Produces: Harness-neutral skill instructions and registry-specific README documentation.

- [ ] **Step 1: Search for harness-specific language**

Run: `rg "Claude Code|Agent tool|AskUserQuestion|~/.claude|subagent_type|model:|Opus|Sonnet|haiku" README.md */SKILL.md`

Expected: matches identify the lines to revise or intentionally retain as cost-tier guidance.

- [ ] **Step 2: Update README wording**

Replace the README with this structure:

```markdown
# skills

A portable collection of agent skills. Each skill lives in its own directory with a `SKILL.md`.

## Skills

| Skill | Use it when |
|-------|-------------|
| [`dark-factory`](dark-factory/SKILL.md) | You want to drive an entire Linear epic (or task) to merged-on-main autonomously - a swarm of implement/review/fix/integrate sub-agents plus a background QA agent, orchestrated under a strict context firewall. Takes a Linear task ID and assumes the orchestrator worktree is already on the user-set epic branch. Changes code and can merge to `main`. |
| [`architecture-audit`](architecture-audit/SKILL.md) | You want a scoped, multi-agent architectural audit of one subsystem - coupling, boundaries, data flow, dependency direction, testability, complexity. Outputs prioritized, TDD-ready tasks. Read-only. |
| [`nextjs-code-quality-audit`](nextjs-code-quality-audit/SKILL.md) | You want a thorough code-quality audit of a Next.js codebase - refactoring opportunities, misplaced concerns, DRY violations, missing tests, structural issues. Read-only. |
| [`elysia-code-quality-audit`](elysia-code-quality-audit/SKILL.md) | You want a thorough code-quality audit of an Elysia (Bun) backend - plugin/scope misuse, missing schema validation, DRY violations, security, tests. Tuned for `apps/` monorepos with Drizzle, Better Auth, pg-boss. Read-only. |
| [`vite-tauri-code-quality-audit`](vite-tauri-code-quality-audit/SKILL.md) | You want a thorough code-quality audit of a Vite + Tauri codebase - IPC boundary issues, misplaced concerns, DRY violations, bundle/build problems, Tauri security misconfig. Read-only. |

## Install

Link a skill directory into the registry for each harness you use. Symlinks keep this repo as the single source of truth, so editing a skill here updates every linked harness.

| Harness | Registry |
|---------|----------|
| Claude | `~/.claude/skills/` |
| OpenCode | `~/.agents/skills/` |
| Codex | `~/.codex/skills/` |

## Link A Skill

```bash
ln -s "$PWD/<skill-name>" ~/.claude/skills/<skill-name>
ln -s "$PWD/<skill-name>" ~/.agents/skills/<skill-name>
ln -s "$PWD/<skill-name>" ~/.codex/skills/<skill-name>
```

## Verify A Link

```bash
ls -la ~/.claude/skills/<skill-name>
ls -la ~/.agents/skills/<skill-name>
ls -la ~/.codex/skills/<skill-name>
```

## Unlink A Skill

```bash
rm ~/.claude/skills/<skill-name>
rm ~/.agents/skills/<skill-name>
rm ~/.codex/skills/<skill-name>
```

Removing a symlink does not remove the source skill directory.

## Harness Notes

Skill instructions are written as generic actions. Each harness maps actions such as dispatching agents, asking the user, reading files, searching files, editing files, and running commands to its native tools.
```

- [ ] **Step 3: Update code-quality audit skills**

For each code-quality audit skill, change:

```markdown
Dispatch **all five agents in parallel** using the Agent tool.
```

or:

```markdown
Dispatch **all six agents in parallel** using the Agent tool.
```

to:

```markdown
Dispatch **all five agents in parallel**.
```

or:

```markdown
Dispatch **all six agents in parallel**.
```

- [ ] **Step 4: Update architecture-audit harness references**

Make these exact semantic replacements:

```markdown
Dispatch via `Agent` with `subagent_type: "general-purpose"` and `model: "sonnet"`.
```

Replace with:

```markdown
Dispatch as a general-purpose fast agent.
```

```markdown
Then ask the user three questions (use `AskUserQuestion` where possible):
```

Replace with:

```markdown
Then ask the user three questions:
```

In the quick reference, replace model-only labels with capability labels:

```markdown
| 2a. Stack scout | Fast agent | Cheap pass for stack + concerns |
| 2b. Discovery | Fast agent | Resolve subsystem to file set |
| 4. 5 lenses | Parallel architect agents | Independent architectural analysis |
```

Replace the common mistake about a named model with:

```markdown
- **Overspending on the stack scout.** Stack detection is mechanical. Use a fast, cheaper agent and save the strongest reasoning for the architect agents.
```

- [ ] **Step 5: Update dark-factory harness references**

Keep the context-firewall and merge workflow unchanged. Replace named model/tool dependency phrasing with portable capability guidance:

```markdown
Dispatch a one-line verification sub-agent and consume its boolean.
```

```markdown
Dispatch one Planner agent. Planning is extraction and topological sorting, not synthesis; a missed soft dep degrades to a rebase conflict the pipeline already recovers from.
```

```markdown
Dispatch a Rebase agent. The rebase is mechanical and structural conflicts escalate anyway.
```

```markdown
Runs in its own loop, independent of the orchestrator's phase machine. Use a capable but cost-conscious agent because it runs for the entire epic and never edits application code:
```

```markdown
- **Model tiers:** clerical agents use cheaper/faster agents. Work agents and CI Fix agents use the session default; never downgrade an agent that writes application code.
```

```markdown
| PLAN | Planner agent | DAG + waves + per-ticket branches |
| QA (background) | QA agent | QA bugs list |
```

- [ ] **Step 6: Validate wording**

Run: `rg "Claude Code|Agent tool|AskUserQuestion|subagent_type|model:" README.md */SKILL.md`

Expected: no matches.

Run: `rg "~/.claude|~/.agents|~/.codex" README.md */SKILL.md`

Expected: matches only in `README.md`.

- [ ] **Step 7: Commit Task 1**

Run: `git status --short`

Expected: only the README, skill files, and this plan are modified or untracked.

Run: `git add README.md architecture-audit/SKILL.md nextjs-code-quality-audit/SKILL.md elysia-code-quality-audit/SKILL.md vite-tauri-code-quality-audit/SKILL.md dark-factory/SKILL.md docs/superpowers/plans/2026-07-06-agent-harness-portability.md && git commit -m "Make skills harness-neutral"`

Expected: commit succeeds.

### Task 2: Link OpenCode And Codex Registries

**Files:**
- External: `~/.agents/skills/<skill-name>`
- External: `~/.codex/skills/<skill-name>`

**Interfaces:**
- Consumes: Repo skill directories.
- Produces: Symlinks in OpenCode and Codex registries.

- [ ] **Step 1: Verify registry directories exist**

Run: `ls -ld ~/.agents/skills ~/.codex/skills`

Expected: both directories exist.

- [ ] **Step 2: Link missing OpenCode skills without overwriting conflicts**

Run each command from repo root:

```bash
test -e ~/.agents/skills/dark-factory || ln -s "$PWD/dark-factory" ~/.agents/skills/dark-factory
test -e ~/.agents/skills/architecture-audit || ln -s "$PWD/architecture-audit" ~/.agents/skills/architecture-audit
test -e ~/.agents/skills/nextjs-code-quality-audit || ln -s "$PWD/nextjs-code-quality-audit" ~/.agents/skills/nextjs-code-quality-audit
test -e ~/.agents/skills/elysia-code-quality-audit || ln -s "$PWD/elysia-code-quality-audit" ~/.agents/skills/elysia-code-quality-audit
test -e ~/.agents/skills/vite-tauri-code-quality-audit || ln -s "$PWD/vite-tauri-code-quality-audit" ~/.agents/skills/vite-tauri-code-quality-audit
```

Expected: commands create missing links and leave existing entries untouched.

- [ ] **Step 3: Link missing Codex skills without overwriting conflicts**

Run each command from repo root:

```bash
test -e ~/.codex/skills/dark-factory || ln -s "$PWD/dark-factory" ~/.codex/skills/dark-factory
test -e ~/.codex/skills/architecture-audit || ln -s "$PWD/architecture-audit" ~/.codex/skills/architecture-audit
test -e ~/.codex/skills/nextjs-code-quality-audit || ln -s "$PWD/nextjs-code-quality-audit" ~/.codex/skills/nextjs-code-quality-audit
test -e ~/.codex/skills/elysia-code-quality-audit || ln -s "$PWD/elysia-code-quality-audit" ~/.codex/skills/elysia-code-quality-audit
test -e ~/.codex/skills/vite-tauri-code-quality-audit || ln -s "$PWD/vite-tauri-code-quality-audit" ~/.codex/skills/vite-tauri-code-quality-audit
```

Expected: commands create missing links and leave existing entries untouched.

- [ ] **Step 4: Verify link targets**

Run: `ls -la ~/.agents/skills ~/.codex/skills`

Expected: each repo skill appears in both registries. Existing non-repo entries remain unchanged.

- [ ] **Step 5: Final validation**

Run: `git status --short`

Expected: clean working tree after Task 1 commit, because registry symlinks are outside this repo.

Run: `git log --oneline -3`

Expected: includes `Make skills harness-neutral` and `Add agent harness portability design`.

## Self-Review

- Spec coverage: Task 1 covers README and skill-body portability. Task 2 covers OpenCode and Codex links.
- Placeholder scan: no unfinished-marker terms or open-ended implementation placeholders.
- Type consistency: not applicable; this is markdown and symlink work.
