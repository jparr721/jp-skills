---
name: upgrading-jp-skills
description: Use when updating jp-skills to the latest version, checking the installed version, or when the cached clone location is unknown
---

# Upgrading jp-skills

## Overview
One cached git clone is the source of truth. Upgrade = pull it, migrate state, relink harnesses, stamp version.

## When to Use
- "Upgrade/update jp-skills", "latest skills", version mismatch, a new skill missing from a registry.
- When NOT to use: editing skills or cutting a release (that's a version-bump task, separate).

## Stable home
Canonical home `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`. Repo `VERSION` is version truth; `config.json` holds the installed copy.

## Flow
1. Resolve repo: `$JP_SKILLS_REPO` → `config.json` `repo_path` → else ask human once and persist. Verify `<repo>/VERSION` exists; else STOP, wrong directory.
2. Ensure `$HOME/servers/`, `$HOME/tmp/`, and `$HOME/worktrees/` exist (`$HOME` = stable home).
3. `git -C <repo> pull --ff-only`. Refused (diverged/dirty) → report `git status --short`, STOP, let the human resolve. Never force-pull.
4. Read `<repo>/VERSION`. If newer than `installed_version`, show the `CHANGELOG.md` entries in between, then run Migration.
5. Migration: move legacy `~/.local/share/server-maintenance/servers/*.md` → home `servers/` (skip names that already exist, never overwrite, report each).
6. Relink: for every `<repo>/*/SKILL.md`, ensure symlinks in `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.pi/agent/skills/`, `~/.omp/agent/skills/`. Restart `omp` afterwards so discovery runs again.
7. Stamp `config.json` (`repo_path`, new `installed_version`, `updated_at`), report old → new plus changelog highlights.
## Common mistakes
- Force-pulling or resetting a dirty tree instead of stopping.
- Overwriting newer server records during migration.
- Editing `VERSION` outside a release task.

## Framework tail
Before finishing, read `../shared/cleanup.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/shared/cleanup.md`) and follow it.
