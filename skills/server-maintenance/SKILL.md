---
name: server-maintenance
description: Use when doing server maintenance, patching, rebooting, or debugging a remote host, making changes, fixing issues, or recording completed operations on a named server, or when connection details for a named server need lookup or saving
---

# Server Maintenance

## Overview
Named server maps to one stable on-disk record. Ask once, persist, never re-ask.

## When to Use
- Updates, reboots, disk/service/log checks, deploys on a remote host.
- User says a server name, "my server", "the VPS", "prod box".
- SSH fails or access path is unclear.
- After any change/fix on a known server: record it in the operations log before finishing.
- When NOT to use: local-only work with no remote host.

## Stable home
Canonical home: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`). Records live in `<home>/servers/` as `<slug>.md`, slug = lowercase server name with `[^a-z0-9-]` collapsed to `-`. Operations logs live beside records as `<slug>.ops.md` (same `<home>/servers/` dir). Scratch goes in `<home>/tmp/server-maintenance/`.
Never store secrets: key paths not key material, password-manager refs not passwords. Never store under repo/cwd — harness-local paths get forgotten.
Legacy fallback: if `<slug>.md` is missing here but exists at `~/.local/share/server-maintenance/servers/<slug>.md`, move it into `<home>/servers/` (pre-v1 location, do not write new records there).

## Flow
1. Resolve name: slugify the given name. None/ambiguous → ask human for server name plus connection instructions (ssh target, user, port, identity file, bastion/jump, VPN prereq, sudo rule).
2. Load `<slug>.md`. Missing → ask once, write the file immediately, before touching the server.
3. Connect with stored instructions verbatim. Never improvise a parallel path (no guessed IP/user/port).
4. On failure → Troubleshooting below, ask human for the correction once, append it to the file, retry.
5. Record: for each recordable operation this session (config file edits, package installs/removals, service start/stop/restart/enable, deploys/releases, reboots, user/cron/firewall/network changes, restores/migrations), append one compact entry to `<slug>.ops.md` — create the file with a `# <server name> — operations log` header on first use. Read-only checks (disk, logs, `systemctl status`) record nothing. Entry shape is `## YYYY-MM-DD — <one-line summary>` plus `- symptom:`, `- change:`, `- verify: <cmd> → <result>` lines; refs/paths only, never secrets. Record runs before the Framework tail.

## Record schema (`<slug>.md`)
```markdown
# <server name>
- ssh_target:
- user:
- port:
- identity_file:
- bastion_jump:
- vpn_prereq:
- sudo:
- verify_cmd: ssh <target> true
## Connection instructions
<exact commands, ssh config stanza, VPN steps>
## Troubleshooting
- <date>: <symptom> → <fix>
```

## Operations log (`<slug>.ops.md`)

One compact entry per recordable operation, appended after the fix is verified:

```markdown
# <server name> — operations log
## 2026-10-02 — Restart nginx after config fix
- symptom: site returned 502 after deploy
- change: fixed proxy_pass in nginx.conf, restarted nginx
- verify: systemctl is-active nginx → active
```

First entry creates the file (with the header); later entries append. Never create the ops file standalone — the connection record (`<slug>.md`) comes first per Flow step 2.

## Troubleshooting
- Auth fail → `ssh -v`, check key path/perms, `ssh-add -l`, server `auth.log`.
- Timeout → VPN up? firewall? `nc -vz <host> <port>`, try bastion path from record.
- Sudo fail → `sudo -n true`, confirm sudo rule in record.
- Every new fix gets one appended line under Troubleshooting; re-ask is a bug.

## Common mistakes
- Re-asking for host on every run instead of loading the record.
- Storing the record in repo/cwd instead of the stable base.
- Guessing connection flags instead of asking once and persisting.
- Saving secrets into the record instead of refs/paths.
- Finishing a change session without appending the ops log entry.
- Logging read-only checks as operations instead of recordable changes only.

## Framework tail
Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
