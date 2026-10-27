---
name: upgrading-jp-skills
description: Use when updating jp-skills to the latest version, checking the installed version, or when the cached clone location is unknown
---

# Upgrading jp-skills

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, say once that Herdr pane orchestration is unavailable and recommend installing Herdr (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/), then continue with this skill's in-process path. If it passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr. Never block work that does not need panes on Herdr.

## Overview
One cached git clone is the source of truth. Upgrade = pull it, migrate state, relink harnesses, stamp version.

## When to Use
- "Upgrade/update jp-skills", "latest skills", version mismatch, a new skill missing from a registry.
- When NOT to use: editing skills or cutting a release (that's a version-bump task, separate).

## Stable home
Canonical home `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `storage.json`, `storage/`, legacy `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`. Repo `VERSION` is version truth; `config.json` holds the installed copy.

## Flow
1. Resolve repo: `$JP_SKILLS_REPO` -> `config.json` `repo_path` -> else ask human once and persist. Verify `<repo>/VERSION` exists; else STOP, wrong directory.
2. Ensure `$JP_SKILLS_HOME/servers/`, `$JP_SKILLS_HOME/tmp/`, and `$JP_SKILLS_HOME/worktrees/` exist (resolve the stable home above without changing the shell HOME variable).
3. Assume `gh` is available and already authenticated; use it directly for private storage setup, without installation/login/token questions or asking the user to create a repo. `git -C <repo> pull --ff-only`. Refused (diverged/dirty) -> report `git status --short` and ahead/behind state, then stop the automatic upgrade. Never force-pull. If the user explicitly asks you to resolve the divergence, follow `references/git-reconciliation.md`: preserve committed and uncommitted work, reconcile both histories, test, restore the original dirty files unchanged, then resume this flow. Reconciliation does not authorize publishing commits.
4. Read `<repo>/VERSION`. If newer than `installed_version`, show the `CHANGELOG.md` entries in between, then run Migration. The storage migration readiness check in step 5 also runs when versions match.
5. **Migration, including private storage:** run the storage check on every upgrade, even when the version is unchanged or this is skill-only (storage migration is not a runtime/profile install). Read `../server-maintenance/references/private-storage.md`. If `<home>/storage.json` is missing, ask what private repository the user wants, default **`jp-skills-storage`**, accept `OWNER/REPO`, then the agent runs `python3 <repo>/skills/cleanup/scripts/storage.py setup --repo <choice>` using authenticated `gh` to create/clone it. Reuse an existing choice; never re-ask or require manual repo creation. Verify private visibility, sync, review legacy files for secrets, then run `migrate` to import both `<home>/servers/*.md` and `~/.local/share/server-maintenance/servers/*.md` into `storage/server-maintenance/ledger/`. Verify every source against retained timestamped import content, check a second import yields zero, and run the post-run hook to commit/reconcile/push/read back. Preserve sources as read-only backups; never overwrite newer facts or invent missing operation times. Record `storage_migration` (`repo`, `completed_at`, verified `commit`) in `config.json` only after successful remote verification. If declined/blocked, leave migration pending, retain sources, and report that separately from any completed skill-version update. Then detect pre-v2: if `<repo>/skills/` is missing but `<repo>/architecture-audit/SKILL.md` exists, this is a v1 checkout. After a clean `pull --ff-only`, delete stale root symlinks (`<skill>` entries that are symlinks to the old root dirs) in all five registries, then continue.
6. Relink: for every `<repo>/skills/*/SKILL.md`, ensure symlinks in `~/.claude/skills/`, `~/.agents/skills/`, `~/.codex/skills/`, `~/.pi/agent/skills/`, `~/.omp/agent/skills/`. Resolve and verify every expected target in every registry; preserve real files/directories rather than overwriting them. Remove dangling registry symlinks and report their targets. Restart only the selected OMP session with authorization so discovery runs again; otherwise report that a restart is pending without disrupting running sessions.
7. Startup companion: skill relinking alone provides no runtime persistence. Read `../../extensions/startup/README.md`. Install or change the companion only when that runtime operation and its OMP profile are explicitly selected; pass `PROFILE` (or `default`) explicitly because a noninteractive install otherwise selects the default. A skill-only upgrade must leave runtime/profile configuration unchanged. Preserve existing plugin settings, user profiles and Startup state. Restart and verify `/startup status` in the actual running host before reporting runtime availability; distinguish verified skill links from unverified runtime readiness. Never overwrite foreign profile files or migrate staff/history by deleting them.
8. Merge the version stamp into `config.json` (`repo_path`, new `installed_version`, full UTC `updated_at`) without losing existing keys or the separate storage migration receipt. Report old -> new, changelog highlights, private repo/ledger location and migration/sync outcome. All new state/receipt information must be timestamped.
## Common mistakes
- Force-pulling or resetting a dirty tree instead of stopping.
- Overwriting newer server records during migration.
- Editing `VERSION` outside a release task.

## Framework tail
Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
