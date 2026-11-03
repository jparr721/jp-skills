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
| [`jp-pipeline`](skills/jp-pipeline/SKILL.md) | A single unit of work — Linear ticket, bug fix, feature — driven from idea to merged PR: design deliberation, parallel implementation, PR, at most two review rounds, stopping on first approval, merge on green CI. Commits early and often; stacks when the caller passes a parent base. | Changes code, merges PR |
| [`jp-dark-factory`](skills/jp-dark-factory/SKILL.md) | A fixed Linear epic driven to merged-on-main autonomously — a swarm of implement/review/fix agents plus background QA under a context firewall. Dependent tickets stack as `--base` chains; merges proceed bottom-up with child retarget. Workers can run in Herdr or Tern panes, or in-process without either terminal. Startup is optional; `STARTUP_MODE=off` runs independently. At most three review rounds per change, including inherited rounds. | Changes code, can merge to `main` |
| [`jp-startup`](skills/jp-startup/SKILL.md) | A persistent queue with one manager, a permanent PA, and architect-led crews in interactive panes. V7 supports OMP with Herdr or Tern, and Claude Code (2.1.302+) with Herdr; full role/loop sources bind each employee. | Changes code, enforces scoped landing gates, monitors progress |
| [`jp-hotfix`](skills/jp-hotfix/SKILL.md) | A bug fix in place on your current branch — opt-in live repro, conditional 1→3 spread check, dead-simple plan gate, at most one light review + simplify pass, final approval gate. Commits per site as it goes. | Commits scoped fix on current branch + opens ready PR, never merges |
| [`jp-quickfix`](skills/jp-quickfix/SKILL.md) | A fix-it-now mode you invoke by hand (`/jp-quickfix`) - edit right here on the current branch, ask only when blocked, fix at the root with the repo's own helpers. No plan gate, worktree, review, or PR. | Edits the working tree in place, never commits |

Review budgets are per change and inherited across nested workflows: `jp-hotfix` allows at most one round, `jp-pipeline` at most two, and `jp-dark-factory` at most three; the stricter inherited or nested cap applies. Stop on the first APPROVE. A round is a completed review with a verdict, not an individual review angle or debate. Startup is optional for all three workflows; when used, its manager chooses a cap of at most three and passes it down.

These workflows use the same coordinator transition engine for scoped assignments, dependency readiness and inherited review budgets. Startup persists its authority; standalone OMP and Claude Code hosts keep their authority for the lifetime of their root process. A selected Startup can delegate bounded work without handing off its queue or landing authority. See the [runtime instructions](extensions/startup/README.md#shared-bounded-workflows).

Startup family (roles + procedures):

| Skill | Use it when |
|-------|-------------|
| [`jp-hire`](skills/jp-hire/SKILL.md) | Add staff through manager authority with idempotent retries and real readiness receipts. |
| [`jp-startup-loop`](skills/jp-startup-loop/SKILL.md) | Every employee wake, scoped inbox result, waiting assignment or duty. |
| [`jp-startup-role-manager`](skills/jp-startup-role-manager/SKILL.md) | Every startup command needs the canonical manager role - sole boss contact, architect-led intake, complete-team dispatch, outcome enforcement, merges. |
| [`jp-startup-role-pa`](skills/jp-startup-role-pa/SKILL.md) | The manager needs its reminder tick — time, check-ins, priorities, sprint count, aging blockers. |
| [`jp-startup-role-dev`](skills/jp-startup-role-dev/SKILL.md) | A worker drains one queue item through the full pipeline with don't-merge and an outcome block. |
| [`jp-startup-role-architect`](skills/jp-startup-role-architect/SKILL.md) | A fresh intake team needs its technical leader, scoped intake, member coordination and required merge gate. |
| [`jp-startup-role-qa`](skills/jp-startup-role-qa/SKILL.md) | Per-item proof or cross-item overlap checks are needed, using the proof standard for the item's kind. |
| [`jp-startup-role-devops`](skills/jp-startup-role-devops/SKILL.md) | The user explicitly requests DevOps coordination, or an item needs environment, resource, or operation adjudication. |
| [`jp-startup-intake`](skills/jp-startup-intake/SKILL.md) | New or successive requests arrive in a Startup, including multiple tasks, shorthand, missing details, and clarifications. Every work intent receives a durable queue record and receipt before readiness checks. |
| [`jp-startup-sprint`](skills/jp-startup-sprint/SKILL.md) | INTERNAL - every 5 merged items record a retro and compress memory while independent ready work continues. |
| [`jp-startup-retro`](skills/jp-startup-retro/SKILL.md) | An on-demand retro is wanted — same procedure as the sprint boundary. |
| [`jp-startup-stop-doing`](skills/jp-startup-stop-doing/SKILL.md) | A text rule or screenshot complaint must become a standing instruction now. |
| [`jp-startup-status`](skills/jp-startup-status/SKILL.md) | The queue, bulletin, sprint count, or parked blockers need rendering (or explicit wipe). |

### Research

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-ask`](skills/jp-ask/SKILL.md) | Talk about the codebase: explain behavior, trace flows, compare approaches, and answer follow-up questions. Hand-invoked with `/jp-ask` (OMP: `/skill:jp-ask`); stays in discussion mode until explicitly ended. | Read-only discussion, no edits or execution |
| [`jp-topic-research`](skills/jp-topic-research/SKILL.md) | Deciding whether prior art, libraries, or battle-tested software already solve a task before committing to a custom plan. | Read-only |
| [`jp-filing-agent-tasks`](skills/jp-filing-agent-tasks/SKILL.md) | Research and refine agent tasks with source-grounded contracts, readiness gates and tracker readback. Discovers available Linear connections and can optionally copy saved tickets to the configured private GitHub storage repository. | Creates/updates tasks, never implements |

### Audits & review

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-architecture-audit`](skills/jp-architecture-audit/SKILL.md) | A scoped multi-agent audit of one subsystem — coupling, boundaries, data flow, testability, complexity. Outputs prioritized, TDD-ready tasks. | Read-only |
| [`jp-pr-review-toolkit`](skills/jp-pr-review-toolkit/SKILL.md) | A pull-request or git-diff review ending in a ship verdict — five adversarial angles (spec, breaker, failure, proof, shape) plus Level/Splinter club fight to APPROVE / FIX-THEN-SHIP / BLOCK with proven must-fix. Canonical review for `jp-pipeline`, `jp-dark-factory` and `jp-hotfix`; inherited per-change caps apply. | Read-only unless you ask for fixes |
| [`jp-code-simplifier`](skills/jp-code-simplifier/SKILL.md) | A finished, reviewed change should be as simple as it can be — one behavior-preserving pass over the diff against the repo's own conventions, each candidate proven equivalent, reverted on red. Final code pass for `jp-pipeline` and `jp-hotfix`. | Edits files in the diff, behavior-preserving |
| [`jp-code-quality-audit`](skills/jp-code-quality-audit/SKILL.md) | A repeatable intake-driven quality audit — scout detects stack/GUI-ness, you pick UI bugs / code bugs / cleanup / full, six lenses run in parallel. | Read-only |
| [`jp-smoke-test`](skills/jp-smoke-test/SKILL.md) | Verifying a live deployment — every page loads, console/network clean, read-only flows work against a base URL. | Read-only against live app, non-mutating |

### Operations

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-server-maintenance`](skills/jp-server-maintenance/SKILL.md) | Maintenance on a named remote server — updates, reboots, disk/service/log checks. Resolves the server to a stable on-disk record under the canonical home, asks once for connection instructions when missing. Stores connection facts and operations in a timestamped ledger in a private GitHub repository (default `jp-skills-storage`); reconciles, commits and pushes through the shared post-run hook. | Mutates remote host |

### Design & hardening

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-architect`](skills/jp-architect/SKILL.md) | Designing before implementing — sketching types, signatures, module shape for non-trivial work. Parallel candidates, red-flag screen, synthesis, implement-against-sketch, scrap-on-friction. | Writes design + code |
| [`jp-correct`](skills/jp-correct/SKILL.md) | An operator keeps correcting agents for the same repo mistakes — find each class, fix at the highest level (architecture > types > lint > test, docs last), prove each check. | Changes repo to prevent mistakes |

### Disciplines

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-typescript-best-practices`](skills/jp-typescript-best-practices/SKILL.md) | Reading or editing any `.ts`/`.tsx` file — discriminated unions, branded types, constructive modeling, `unknown`-over-`any`, schema-derived types, exhaustiveness. | Editing guidance, read-only effect |

### Meta

| Skill | Use it when | Effect |
|-------|-------------|--------|
| [`jp-upgrading-jp-skills`](skills/jp-upgrading-jp-skills/SKILL.md) | Updating jp-skills to the latest version, checking the installed version. Pulls the cached clone, migrates state, relinks harnesses. | Updates clone + symlinks |

## Versioning

`VERSION` at the repo root is the version source of truth (8.1.1). `CHANGELOG.md` records every release; v1.0.0 logs the breaking changes. Consumers pin trust to released versions, not `main`.

## Stable home

Canonical home `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (Windows `%APPDATA%\jp-skills`): `config.json`, `storage.json`, `storage/` (private git clone), legacy `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`. Server state now lives in `storage/server-maintenance/ledger/<slug>.json`; each fact/event has a UTC timestamp. The storage repo is separate from this public skills checkout and has room for future skill namespaces. `tmp/` is scratch — the Framework tail (`skills/jp-cleanup/SKILL.md`, appended to every skill except `jp-cleanup` itself) clears your own scratch and persists record corrections at session end. `jp-pipeline` (and `jp-dark-factory` via `jp-pipeline`) creates isolated git worktrees under `worktrees/` grouped by repo, so `git worktree list` stays traceable in one place.

## Upgrading

Run the [`jp-upgrading-jp-skills`](skills/jp-upgrading-jp-skills/SKILL.md) skill: resolves the cached clone (`$JP_SKILLS_REPO` → `config.json` → ask once), `git pull --ff-only`, migrates pre-v1 server records, relinks the five standard harness registries, and stamps `installed_version`. Hermes is checked only on explicit request. Every upgrade also checks private-storage migration: assume `gh` is installed and authenticated, ask once for the repo name (default `jp-skills-storage`), have the agent create/clone it privately, import and verify legacy records, then commit/reconcile/push. Migration is tracked separately from the installed skill version; legacy files remain recovery copies. See [private storage](skills/jp-server-maintenance/references/private-storage.md).

## Private ledger storage

Assume authenticated `gh`; the agent performs repository creation/cloning rather than asking the user to do it. The user chooses the private repo once, default `jp-skills-storage`. The shared cleanup tail executes `skills/jp-cleanup/scripts/post-run.py` after each run: commit changed ledgers, fetch, merge each fact/event by its timestamp, push and read back the remote SHA. Distinct operations survive concurrent hosts. Failures retain local work and report unsynchronized state; there is no force-push or blanket ours/theirs conflict resolution. This is a portable skill-tail hook, not an automatically installed harness-global hook; hard-killed runs recover on the next sync.

```sh
python3 skills/jp-cleanup/scripts/storage.py setup --repo <chosen-name-or-owner/repo>
python3 skills/jp-cleanup/scripts/storage.py migrate
python3 skills/jp-cleanup/scripts/post-run.py
python3 -m unittest discover -s tests -v
```

All new ledger data is timestamped; legacy import times are distinguished from unknown original operation times. Review old records for secrets before migration. Python 3.10+, git and authenticated `gh` are assumed for this storage backend. No extra runtime/profile installation is needed.

## Dependencies

Most skills are self-contained. External/runtime requirements:

| Skill | Requires |
|-------|----------|
| `jp-pipeline` | `jp-pr-review-toolkit` and `jp-code-simplifier` (this repo, linked), the `superpowers` plugin for `brainstorming` and `writing-plans` (`claude plugin install superpowers@claude-plugins-official`), `gh`, and an available Linear integration when the input is a ticket. |
| `jp-dark-factory` | Linear MCP, `gh`, and a worktree or VM pool. |
| `jp-server-maintenance` / configured storage cleanup | Python 3.10+, git and authenticated `gh`; a user-selected private storage repository. |
| `jp-dark-factory` (optional panes) | Herdr or Tern; otherwise uses in-process fan-out. Tern's launch recipe uses `omp`. |

## Install

Link a skill directory into the registry for each harness you use. Symlinks keep this repo as the single source of truth, so editing a skill here updates every linked harness.

| Harness | Registry |
|---------|----------|
| Claude | `~/.claude/skills/` |
| OpenCode | `~/.agents/skills/` |
| Codex | `~/.codex/skills/` |
| Pi | `~/.pi/agent/skills/` |
| Oh My Pi (`omp`) | `~/.omp/agent/skills/` |
| Hermes | `${HERMES_HOME:-~/.hermes}/skills/` (selected profile only) |

## Link A Skill

```bash
skill='jp-<skill-name>'
[ -f "skills/$skill/SKILL.md" ] || exit 1
for registry in "$HOME/.claude/skills" "$HOME/.agents/skills" \
  "$HOME/.codex/skills" "$HOME/.pi/agent/skills" "$HOME/.omp/agent/skills"; do
  mkdir -p "$registry" || continue
  dest="$registry/$skill"
  if [ -e "$dest" ] || [ -L "$dest" ]; then
    printf 'Preserved existing entry; verify target: %s\n' "$dest"
  else
    ln -s "$PWD/skills/$skill" "$dest"
  fi
done
```

## Link Everything

```bash
for d in skills/*/; do
  skill="${d%/}"
  skill="${skill#skills/}"
  [ -f "skills/$skill/SKILL.md" ] || continue
  for registry in "$HOME/.claude/skills" "$HOME/.agents/skills" \
    "$HOME/.codex/skills" "$HOME/.pi/agent/skills" "$HOME/.omp/agent/skills"; do
    mkdir -p "$registry" || continue
    dest="$registry/$skill"
    if [ -e "$dest" ] || [ -L "$dest" ]; then
      printf 'Preserved existing entry; verify target: %s\n' "$dest"
    else
      ln -s "$PWD/skills/$skill" "$dest"
    fi
  done
done
```

Restart `omp` after adding or removing skills so discovery runs again. Hermes is optional and is not touched by these commands; when explicitly requested, link to its selected profile's registry and use `/reload-skills` or start a new session. Preserve real directories rather than overwriting them.

## Verify A Link

```bash
ls -la ~/.claude/skills/<skill-name>
ls -la ~/.agents/skills/<skill-name>
ls -la ~/.codex/skills/<skill-name>
ls -la ~/.pi/agent/skills/<skill-name>
ls -la ~/.omp/agent/skills/<skill-name>
ls -la "${HERMES_HOME:-$HOME/.hermes}/skills/<skill-name>"
```

## Unlink A Skill

```bash
rm ~/.claude/skills/<skill-name>
rm ~/.agents/skills/<skill-name>
rm ~/.codex/skills/<skill-name>
rm ~/.pi/agent/skills/<skill-name>
rm ~/.omp/agent/skills/<skill-name>
rm "${HERMES_HOME:-$HOME/.hermes}/skills/<skill-name>"
```

Removing a symlink does not remove the source skill directory.

## Repo Layout

```text
jp-skills/
  VERSION                 # Version source of truth
  CHANGELOG.md            # Release record; v1.0.0 logs the breaking changes
  skills/jp-cleanup/SKILL.md # Terminal shared skill, no tail
  shared/cleanup.md       # Archival pointer only
  skills/<skill-name>/
    SKILL.md              # Main reference (required), ends with Framework tail
    <supporting files>    # Only for heavy reference or reusable tools
  docs/
    superpowers/          # Upstream reference material
```

## Adding A Skill

New skills use a `jp-` name and directory and follow the same shape: one directory, one `SKILL.md` with `name` + `description` frontmatter ending in the Framework tail (`../jp-cleanup/SKILL.md`), supporting files only when the main reference would exceed ~500 words. Add one row to the category table above; breaking changes go in `CHANGELOG.md` with a `VERSION` bump.

## Harness Notes

Skill instructions are written as generic actions. Each harness maps actions such as dispatching agents, asking the user, reading files, searching files, editing files, and running commands to its native tools.

Pane orchestration is optional for ordinary skills. `jp-dark-factory` supports Herdr, Tern or in-process fan-out; only the principal controls panes created by its run. Startup V7 has separate runtime admission requirements described below.

Startup V7 requires Bun, the companion, and a supported harness/pane backend: OMP with Herdr or Tern, or Claude Code (2.1.302+) with Herdr. Herdr uses its managed harness integration; Tern uses native lifecycle and process attestation. Compatibility follows required live APIs and native hooks; release numbers are diagnostic metadata, including across major upgrades. It runs one independent coordinator and one harness root per employee, grouped into hierarchical crews. Linking skills alone does not install the runtime. See [install, boot and tool contracts](extensions/startup/README.md), [design and deployment limits](docs/startup-v7/design.md), and [native guard proof](extensions/startup/probes/v7-native-guards.json). The [live acceptance report](docs/startup-v7/acceptance.md) records a Herdr run, not Tern acceptance. V6 migration and automatic restore remain unsupported/unverified; companion installation remains profile-specific. The [V6 acceptance record](extensions/startup/probes/v6-acceptance.md) remains historical. Full-source binding is specified in [role-dispatch](skills/jp-startup/references/role-dispatch.md).

Oh My Pi surfaces linked skills as namespaced slash commands: type `/skill:` (e.g. `/skill:jp-pipeline`), not `/<skill-name>`. Restart `omp` after linking so startup discovery picks them up.
