# jp-skills

A portable collection of agent skills. Each skill lives in its own directory with a `SKILL.md`. This repo is the single source of truth — link skills into each harness via symlinks, so editing here updates everywhere.

## Categories

- **Orchestration** — drive units of work end to end, supervised or autonomous.
- **Research** — check prior art before committing to a custom plan.
- **Audits & review** — scoped read-only analysis of architecture, quality, and diffs.
- **Operations** — stateful remote work with persistent connection memory.

## Skills

### Orchestration

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`pipeline`](pipeline/SKILL.md) | A single unit of work — Linear ticket, bug fix, feature — driven from idea to merged PR: design deliberation, parallel implementation, PR, ≥2 review rounds, merge on green CI. | Changes code, merges PR |
| [`dark-factory`](dark-factory/SKILL.md) | An entire Linear epic driven to merged-on-main autonomously — a swarm of implement/review/fix agents plus background QA under a context firewall. | Changes code, can merge to `main` |

### Research

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`topic-research`](topic-research/SKILL.md) | Deciding whether prior art, libraries, or battle-tested software already solve a task before committing to a custom plan. | Read-only |

### Audits & review

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`architecture-audit`](architecture-audit/SKILL.md) | A scoped multi-agent audit of one subsystem — coupling, boundaries, data flow, testability, complexity. Outputs prioritized, TDD-ready tasks. | Read-only |
| [`pr-review-toolkit`](pr-review-toolkit/SKILL.md) | A pull-request or git-diff review across comments, tests, error handling, type design, and simplification. | Read-only unless you ask for fixes |
| [`nextjs-code-quality-audit`](nextjs-code-quality-audit/SKILL.md) | A thorough quality audit of a Next.js codebase — misplaced concerns, DRY violations, missing tests, structural issues. | Read-only |
| [`elysia-code-quality-audit`](elysia-code-quality-audit/SKILL.md) | A thorough quality audit of an Elysia (Bun) backend. Tuned for `apps/` monorepos with Drizzle, Better Auth, pg-boss. | Read-only |
| [`vite-tauri-code-quality-audit`](vite-tauri-code-quality-audit/SKILL.md) | A thorough quality audit of a Vite + Tauri codebase — IPC boundaries, bundle/build, Tauri security misconfig. | Read-only |

### Operations

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`server-maintenance`](server-maintenance/SKILL.md) | Maintenance on a named remote server — updates, reboots, disk/service/log checks. Resolves the server to a stable on-disk record under the canonical home, asks once for connection instructions when missing. | Mutates remote host |

### Meta

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`upgrading-jp-skills`](upgrading-jp-skills/SKILL.md) | Updating jp-skills to the latest version, checking the installed version. Pulls the cached clone, migrates state, relinks harnesses. | Updates clone + symlinks |

## Versioning

`VERSION` at the repo root is the version source of truth (currently 1.0.0). `CHANGELOG.md` records every release; v1.0.0 logs the breaking changes. Consumers pin trust to released versions, not `main`.

## Stable home

Canonical home `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `servers/`, `tmp/<skill>/`. Skills cache state here, never in the repo or cwd. `tmp/` is scratch — the Framework tail (`shared/cleanup.md`, appended to every skill) clears your own scratch and persists record corrections at session end.

## Upgrading

Run the [`upgrading-jp-skills`](upgrading-jp-skills/SKILL.md) skill: resolves the cached clone (`$JP_SKILLS_REPO` → `config.json` → ask once), `git pull --ff-only`, migrates pre-v1 server records, relinks all three harness registries, stamps `installed_version`.

## Dependencies

Most skills are self-contained. Two are not:

| Skill | Requires |
|-------|----------|
| `pipeline` | `pr-review-toolkit` (this repo, linked), the `superpowers` plugin for `brainstorming` and `writing-plans` (`claude plugin install superpowers@claude-plugins-official`), `gh`, and Linear MCP when the task is given as a ticket id. |
| `dark-factory` | Linear MCP, `gh`, and a worktree or VM pool. |

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

## Link Everything

```bash
for d in */; do
  skill="${d%/}"
  [ -f "$skill/SKILL.md" ] || continue
  ln -s "$PWD/$skill" ~/.claude/skills/$skill 2>/dev/null
  ln -s "$PWD/$skill" ~/.agents/skills/$skill 2>/dev/null
  ln -s "$PWD/$skill" ~/.codex/skills/$skill 2>/dev/null
done
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

## Repo Layout

```text
jp-skills/
  VERSION                 # Version source of truth
  CHANGELOG.md            # Release record; v1.0.0 logs the breaking changes
  shared/cleanup.md       # Framework tail appended to every skill
  <skill-name>/
    SKILL.md              # Main reference (required), ends with Framework tail
    <supporting files>    # Only for heavy reference or reusable tools
  docs/
    superpowers/          # Upstream reference material
```

## Adding A Skill

New skills follow the same shape: one directory, one `SKILL.md` with `name` + `description` frontmatter ending in the Framework tail (`../shared/cleanup.md`), supporting files only when the main reference would exceed ~500 words. Add one row to the category table above; breaking changes go in `CHANGELOG.md` with a `VERSION` bump.

## Harness Notes

Skill instructions are written as generic actions. Each harness maps actions such as dispatching agents, asking the user, reading files, searching files, editing files, and running commands to its native tools.
