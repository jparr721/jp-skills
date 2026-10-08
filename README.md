# jp-skills

A portable collection of agent skills. Each skill lives in its own directory with a `SKILL.md`. This repo is the single source of truth — link skills into each harness via symlinks, so editing here updates everywhere.

## Categories
- **Orchestration** — drive units of work end to end, supervised or autonomous.
- **Research** — check prior art before committing to a custom plan.
- **Audits & review** — scoped read-only analysis of architecture, quality, and diffs.
- **Operations** — stateful remote work with persistent connection memory.
- **Design & hardening** — sketch the shape before code, then make repeated mistakes impossible.
- **Disciplines** — path-triggered editing rules applied to the file under hand.

## Skills

### Orchestration

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`pipeline`](skills/pipeline/SKILL.md) | A single unit of work — Linear ticket, bug fix, feature — driven from idea to merged PR: design deliberation, parallel implementation, PR, ≥2 review rounds, merge on green CI. | Changes code, merges PR |
| [`dark-factory`](skills/dark-factory/SKILL.md) | An entire Linear epic driven to merged-on-main autonomously — a swarm of implement/review/fix agents plus background QA under a context firewall. | Changes code, can merge to `main` |
| [`hotfix`](skills/hotfix/SKILL.md) | A bug fix in place on your current branch — opt-in live repro, conditional 1→3 spread check, dead-simple plan gate, light review + simplify pass, final approval gate. | Commits scoped fix on current branch + opens ready PR, never merges |

### Research

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`topic-research`](skills/topic-research/SKILL.md) | Deciding whether prior art, libraries, or battle-tested software already solve a task before committing to a custom plan. | Read-only |

### Audits & review

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`architecture-audit`](skills/architecture-audit/SKILL.md) | A scoped multi-agent audit of one subsystem — coupling, boundaries, data flow, testability, complexity. Outputs prioritized, TDD-ready tasks. | Read-only |
| [`pr-review-toolkit`](skills/pr-review-toolkit/SKILL.md) | A pull-request or git-diff review ending in a ship verdict — five adversarial angles (spec, breaker, failure, proof, shape) plus Level/Splinter club fight to APPROVE / FIX-THEN-SHIP / BLOCK with proven must-fix. Canonical review for pipeline, dark-factory (via pipeline), hotfix. | Read-only unless you ask for fixes |
| [`code-simplifier`](skills/code-simplifier/SKILL.md) | A finished, reviewed change should be as simple as it can be — one behavior-preserving pass over the diff against the repo's own conventions, each candidate proven equivalent, reverted on red. Final code pass for pipeline and hotfix. | Edits files in the diff, behavior-preserving |
| [`code-quality-audit`](skills/code-quality-audit/SKILL.md) | A repeatable intake-driven quality audit — scout detects stack/GUI-ness, you pick UI bugs / code bugs / cleanup / full, six lenses run in parallel. | Read-only |
| [`smoke-test`](skills/smoke-test/SKILL.md) | Verifying a live deployment — every page loads, console/network clean, read-only flows work against a base URL. | Read-only against live app, non-mutating |

### Operations

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`server-maintenance`](skills/server-maintenance/SKILL.md) | Maintenance on a named remote server — updates, reboots, disk/service/log checks. Resolves the server to a stable on-disk record under the canonical home, asks once for connection instructions when missing. Records completed operations to a per-server log. | Mutates remote host |

### Design & hardening

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`architect`](skills/architect/SKILL.md) | Designing before implementing — sketching types, signatures, module shape for non-trivial work. Parallel candidates, red-flag screen, synthesis, implement-against-sketch, scrap-on-friction. | Writes design + code |
| [`correct`](skills/correct/SKILL.md) | An operator keeps correcting agents for the same repo mistakes — find each class, fix at the highest level (architecture > types > lint > test, docs last), prove each check. | Changes repo to prevent mistakes |

### Disciplines

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`typescript-best-practices`](skills/typescript-best-practices/SKILL.md) | Reading or editing any `.ts`/`.tsx` file — discriminated unions, branded types, constructive modeling, `unknown`-over-`any`, schema-derived types, exhaustiveness. | Editing guidance, read-only effect |

### Meta

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`upgrading-jp-skills`](skills/upgrading-jp-skills/SKILL.md) | Updating jp-skills to the latest version, checking the installed version. Pulls the cached clone, migrates state, relinks harnesses. | Updates clone + symlinks |

## Versioning

`VERSION` at the repo root is the version source of truth (currently 3.1.0). `CHANGELOG.md` records every release; v1.0.0 logs the breaking changes. Consumers pin trust to released versions, not `main`.

## Stable home

Canonical home `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`. Skills cache state here, never in the repo or cwd. `tmp/` is scratch — the Framework tail (`skills/cleanup/SKILL.md`, appended to every skill except `cleanup` itself) clears your own scratch and persists record corrections at session end. `pipeline` (and `dark-factory` via `pipeline`) creates isolated git worktrees under `worktrees/` grouped by repo, so `git worktree list` stays traceable in one place.

## Upgrading

Run the [`upgrading-jp-skills`](skills/upgrading-jp-skills/SKILL.md) skill: resolves the cached clone (`$JP_SKILLS_REPO` → `config.json` → ask once), `git pull --ff-only`, migrates pre-v1 server records, relinks all five harness registries, stamps `installed_version`.

## Dependencies

Most skills are self-contained. Two are not:

| Skill | Requires |
|-------|----------|
| `pipeline` | `pr-review-toolkit` and `code-simplifier` (this repo, linked), the `superpowers` plugin for `brainstorming` and `writing-plans` (`claude plugin install superpowers@claude-plugins-official`), `gh`, and Linear MCP when the task is given as a ticket id. |
| `dark-factory` | Linear MCP, `gh`, and a worktree or VM pool. |

## Install

Link a skill directory into the registry for each harness you use. Symlinks keep this repo as the single source of truth, so editing a skill here updates every linked harness.

| Harness | Registry |
|---------|----------|
| Claude | `~/.claude/skills/` |
| OpenCode | `~/.agents/skills/` |
| Codex | `~/.codex/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Oh My Pi (`omp`) | `~/.omp/agent/skills/` |

## Link A Skill

```bash
ln -s "$PWD/skills/<skill-name>" ~/.claude/skills/<skill-name>
ln -s "$PWD/skills/<skill-name>" ~/.agents/skills/<skill-name>
ln -s "$PWD/skills/<skill-name>" ~/.codex/skills/<skill-name>
ln -s "$PWD/skills/<skill-name>" ~/.pi/agent/skills/<skill-name>
ln -s "$PWD/skills/<skill-name>" ~/.omp/agent/skills/<skill-name>
```

## Link Everything

```bash
for d in skills/*/; do
  skill="${d%/}"
  skill="${skill#skills/}"
  [ -f "skills/$skill/SKILL.md" ] || continue
  ln -s "$PWD/skills/$skill" ~/.claude/skills/$skill 2>/dev/null
  ln -s "$PWD/skills/$skill" ~/.agents/skills/$skill 2>/dev/null
  ln -s "$PWD/skills/$skill" ~/.codex/skills/$skill 2>/dev/null
  ln -s "$PWD/skills/$skill" ~/.pi/agent/skills/$skill 2>/dev/null
  ln -s "$PWD/skills/$skill" ~/.omp/agent/skills/$skill 2>/dev/null
done
```

Restart `omp` after adding or removing skills so discovery runs again.

## Verify A Link

```bash
ls -la ~/.claude/skills/<skill-name>
ls -la ~/.agents/skills/<skill-name>
ls -la ~/.codex/skills/<skill-name>
ls -la ~/.pi/agent/skills/<skill-name>
ls -la ~/.omp/agent/skills/<skill-name>
```

## Unlink A Skill

```bash
rm ~/.claude/skills/<skill-name>
rm ~/.agents/skills/<skill-name>
rm ~/.codex/skills/<skill-name>
rm ~/.pi/agent/skills/<skill-name>
rm ~/.omp/agent/skills/<skill-name>
```

Removing a symlink does not remove the source skill directory.

## Repo Layout

```text
jp-skills/
  VERSION                 # Version source of truth
  CHANGELOG.md            # Release record; v1.0.0 logs the breaking changes
  skills/cleanup/SKILL.md # Terminal shared skill, no tail
  shared/cleanup.md       # Archival pointer only
  skills/<skill-name>/
    SKILL.md              # Main reference (required), ends with Framework tail
    <supporting files>    # Only for heavy reference or reusable tools
  docs/
    superpowers/          # Upstream reference material
```

## Adding A Skill

New skills follow the same shape: one directory, one `SKILL.md` with `name` + `description` frontmatter ending in the Framework tail (`../cleanup/SKILL.md`), supporting files only when the main reference would exceed ~500 words. Add one row to the category table above; breaking changes go in `CHANGELOG.md` with a `VERSION` bump.

## Harness Notes

Skill instructions are written as generic actions. Each harness maps actions such as dispatching agents, asking the user, reading files, searching files, editing files, and running commands to its native tools.

Oh My Pi surfaces linked skills as namespaced slash commands: type `/skill:` (e.g. `/skill:pipeline`), not `/<skill-name>`. Restart `omp` after linking so startup discovery picks them up.
