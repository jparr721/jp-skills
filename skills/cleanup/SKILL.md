---
name: cleanup
description: Runs after every other skill runs — clears your own tmp scratch under the canonical home and persists record corrections to the owning record. Terminal skill with no Framework tail.
---

# Cleanup

Runs after every other skill runs. This skill is terminal: it has no Framework tail and no other skill tails into anything else.

## Canonical home

`$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`): `config.json` (`repo_path`, `installed_version`, `updated_at`), `servers/`, `tmp/<skill>/`, `worktrees/<repo>/<branch>/`.

## Steps

1. Clear only `tmp/<your-skill-name>/` scratch you made. Other skills' scratch is theirs. Scratch is never committed.
2. Persist corrections into the owning record under the home dir (server fixes go to `servers/<slug>.md` Troubleshooting) so the next run inherits them.
3. Never touch `VERSION`, `CHANGELOG.md`, or another skill's records during a normal run.
