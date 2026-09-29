# Changelog

`VERSION` at the repo root is the version source of truth. The installed copy lives in `<canonical-home>/config.json` (`installed_version`); canonical home is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`.

## [1.0.0] - 2026-09-29

### Breaking

- Repo themed as jp-skills; README grouped by category (Orchestration, Research, Audits & review, Operations).
- Stable home introduced under XDG (`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`) with `config.json`, `servers/`, `tmp/`. server-maintenance records moved from `~/.local/share/server-maintenance/servers/`; the upgrade skill migrates them automatically.
- Every skill ends with a Framework tail pointing at `shared/cleanup.md` (scratch hygiene, record persistence).

### Added

- `VERSION` file as version truth; this changelog.
- `upgrading-jp-skills` skill: resolves the cached clone, `git pull --ff-only`, migrates legacy records, relinks all three harness registries, stamps the installed version.
