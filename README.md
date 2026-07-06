# skills

A portable collection of agent skills. Each skill lives in its own directory with a `SKILL.md`.

## Skills

| Skill | Use it when |
|-------|-------------|
| [`dark-factory`](dark-factory/SKILL.md) | You want to drive an entire Linear epic (or task) to merged-on-main autonomously - a swarm of implement/review/fix/integrate sub-agents plus a background QA agent, orchestrated under a strict context firewall. Takes a Linear task ID, renames the branch to Linear's `gitBranchName`. Changes code and can merge to `main`. |
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
