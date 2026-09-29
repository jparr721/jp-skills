---
name: server-maintenance
description: Use when doing server maintenance, patching, rebooting, or debugging a remote host, or when connection details for a named server need lookup or saving
---

# Server Maintenance

## Overview
Named server maps to one stable on-disk record. Ask once, persist, never re-ask.

## When to Use
- Updates, reboots, disk/service/log checks, deploys on a remote host.
- User says a server name, "my server", "the VPS", "prod box".
- SSH fails or access path is unclear.
- When NOT to use: local-only work with no remote host.

## Stable path
Base: `$SERVER_MAINTENANCE_DIR` else `~/.local/share/server-maintenance/servers/`. File: `<slug>.md`, slug = lowercase server name with `[^a-z0-9-]` collapsed to `-`.
Never store secrets: key paths not key material, password-manager refs not passwords. Never store under repo/cwd — harness-local paths get forgotten.

## Flow
1. Resolve name: slugify the given name. None/ambiguous → ask human for server name plus connection instructions (ssh target, user, port, identity file, bastion/jump, VPN prereq, sudo rule).
2. Load `<slug>.md`. Missing → ask once, write the file immediately, before touching the server.
3. Connect with stored instructions verbatim. Never improvise a parallel path (no guessed IP/user/port).
4. On failure → Troubleshooting below, ask human for the correction once, append it to the file, retry.

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
