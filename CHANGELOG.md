# Changelog

`VERSION` at the repo root is the version source of truth. The installed copy lives in `<canonical-home>/config.json` (`installed_version`); canonical home is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`.

## [1.4.0] - 2026-10-02

### Added

- `server-maintenance` operations log: completed operations (config edits, installs, service changes, deploys, reboots, user/cron/firewall/network changes, restores/migrations) append one compact entry (symptom / change / verify) to `<home>/servers/<slug>.ops.md` via a mandatory RECORD step before the cleanup tail. Read-only checks record nothing; connection record and legacy fallback unchanged.

## [1.3.0] - 2026-10-02

### Changed

- `hotfix` now ships a ready PR: scoped commit on the current branch (approved-scope `git add` only), push, `gh pr create` ready never `--draft` (`gh pr ready` repair), stop-and-report on the target branch; VERIFY reuses Step 1 intake creds for auth checks (ask only when missing/expired/lacking scope, session-only hygiene, never in PR body).
- `pipeline` Step 5 opens ready PRs (`gh pr ready` repair); activation line ships in the same turn as the first Step 1 action with a ~2 min stall rule (emit intake block, continue).
- `dark-factory` outcomes require ready PR URLs (draft is a protocol violation); `AUTO_MERGE` merge decision unchanged.

## [1.2.0] - 2026-09-29

### Added

- `hotfix` skill: in-place bug fixes on the current branch — opt-in live repro with session-only creds (`provided (redacted)`), conditional 1→3 issue-spread analysis, dead-simple 5-line plan gate, single-implementer fix, repro + touched-file verification. Working tree only; never commits, pushes, worktrees, or merges.

## [1.1.0] - 2026-09-29

### Changed

- `pipeline` worktrees now live under the canonical home at `<home>/worktrees/<repo>/<branch>` (`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`), grouped by repo for tracking. Repo recipes that accept a target path get the derived path; recipes with hard-coded locations are bypassed for a bare `git worktree add` at the derived path unless they cannot work elsewhere.
- `dark-factory` `WORKTREE_MODE=local` follows the same `pipeline` Step 1b contract; fan-out and cleanup reference `<home>/worktrees/<repo>/<branch>`, orchestrator checkout untouched.
- Stable home layout gains `worktrees/<repo>/<branch>/`; `upgrading-jp-skills` ensures `worktrees/` exists alongside `servers/` and `tmp/`.
- Harness registries cover five targets (adds Pi, Oh My Pi); `omp` restart noted after (re)linking.

## [1.0.0] - 2026-09-29

### Breaking

- Repo themed as jp-skills; README grouped by category (Orchestration, Research, Audits & review, Operations).
- Stable home introduced under XDG (`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`) with `config.json`, `servers/`, `tmp/`. server-maintenance records moved from `~/.local/share/server-maintenance/servers/`; the upgrade skill migrates them automatically.
- Every skill ends with a Framework tail pointing at `shared/cleanup.md` (scratch hygiene, record persistence).

### Added

- `VERSION` file as version truth; this changelog.
- `upgrading-jp-skills` skill: resolves the cached clone, `git pull --ff-only`, migrates legacy records, relinks all three harness registries, stamps the installed version.
