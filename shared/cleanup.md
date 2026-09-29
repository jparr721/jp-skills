# Shared cleanup tail

Every jp-skills skill ends here. Canonical home: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`).

1. Clear only `tmp/<your-skill-name>/` scratch you made. Other skills' scratch is theirs. Scratch is never committed.
2. Persist corrections into the owning record under the home dir (server fixes go to `servers/<slug>.md` Troubleshooting) so the next run inherits them.
3. Never touch `VERSION`, `CHANGELOG.md`, or another skill's records during a normal run.
