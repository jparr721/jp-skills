---
name: server-maintenance
description: Use when doing server maintenance, patching, rebooting, or debugging a remote host, making changes, fixing issues, or recording completed operations on a named server, or when connection details for a named server need lookup or saving
---

# Server Maintenance

## Herdr preflight
Run `test "${HERDR_ENV:-}" = 1` before dispatch or pane work. If it fails, check `command -v herdr`: an installed binary does not mean this session is inside Herdr. Say once that this session is outside Herdr, then continue with this skill's in-process path. Recommend installation (`curl -fsSL https://herdr.dev/install.sh | sh`; docs https://herdr.dev/docs/install/) only when the binary is actually missing. If the environment check passes, control panes only through the `herdr` CLI in this session; read `herdr --skill` before the first pane command. Never inspect or control panes from outside Herdr or set HERDR_ENV manually to bypass the check. Never block work that does not need panes on Herdr.

## Overview
Named server maps to one stable on-disk record. Ask once, persist, never re-ask.

## When to Use
- Updates, reboots, disk/service/log checks, deploys on a remote host.
- User says a server name, "my server", "the VPS", "prod box".
- SSH fails or access path is unclear.
- After any change/fix on a known server: record it in the operations log before finishing.
- Local maintenance explicitly requested with this skill: use the local-host procedure in `references/local-disk-maintenance.md`; do not invent an SSH target or require remote connection details.

## Infisical upgrades
- For self-hosted Infisical Docker upgrades, follow `references/infisical-upgrades.md` for release review, protected/restorable backups, backend-only rollout, and authenticated acceptance before conditional backup removal.

## Specialized read-only checks
- Immich exports to Apple Photos: follow `references/immich-export-assessment.md` for checksum, Live Photo companion, and embedded-date gates.

## Stable home
Canonical home: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (Windows `%APPDATA%\jp-skills`). Private storage is a separate git clone at `<home>/storage/`; its repository and branch are saved in `<home>/storage.json`. Server connection fields and operations share `<home>/storage/server-maintenance/ledger/<slug>.json`. Slug = lowercase server name with `[^a-z0-9-]` collapsed to `-`; `ledger` is reserved for the ledger manifest. Scratch remains `<home>/tmp/server-maintenance/`, outside git.
Assume `gh` exists and is already authenticated. Use it directly; do not ask users to install it, log in, supply a token, or manually create the repository. First use without storage configuration: ask what private repository they want, recommending `jp-skills-storage` (accept a name or `OWNER/REPO`), then create or clone it with the helper in `references/private-storage.md`. If the user already selected the default, do not ask again. Always read back private visibility before writing or pushing; never downgrade to a public repository.
Never store secrets: key paths not key material, password-manager refs not passwords. Do not put operational state in the public skills checkout or a task cwd. Legacy `<home>/servers/*.md` and `~/.local/share/server-maintenance/servers/*.md` are migration sources only; import and verify them per the reference, then stop writing them.

## Scope and reporting
- Default an unqualified disk/resource question to the current host. Resolve it with live system tools; do not check peers merely because they appeared earlier in the conversation. Use remote hosts only when explicitly named or the established task targets them.
- Treat “see what we can clear” as a read-only candidate audit, not deletion approval. Rank candidates with measured size, required safety checks, and rebuild/download consequences; obtain approval before a cleanup pass unless existing standing authorization covers it.
- For progress questions, combine a fresh disk measurement with the actual scheduled job's latest execution state. Keep historical cleanup results separate from current usage; never present an old report as a fresh reading.
- For disk/resource reports, report host, used percentage, and available space first. Distinguish directory footprint, provider-reported reclaimable space, and verified filesystem recovery; do not sum overlapping categories or mix GB with GiB. For service incidents, lead with the failing workflow and verified evidence rather than unrelated disk statistics.

## Flow
1. Resolve scope first: use `local` for the current host; otherwise slugify the explicitly selected server name. Ask for connection instructions only when a required remote target cannot be resolved from its existing record.
2. Set up private storage if needed, run the helper’s `sync` to fetch and reconcile current information, then load `<slug>.json` before connecting. If missing, use an explicit target supplied by the user or established context to write timestamped connection fields with `put`; ask only for genuinely missing details. If sync is unavailable, disclose that the local record may be stale; do not imply it is current.
3. Honor current user connection policy over stale record text. Use Tailscale DNS for this user's SSH connections, never LAN IP fallbacks; correct superseded connection fields in place. Do not guess users, ports, keys or bastions.
4. On failure → run the read-only Troubleshooting sequence below before asking for a correction. Distinguish DNS/VPN reachability, TCP connection, SSH authentication and session creation; ask only when the remaining blocker requires human input.
5. Record: for each recordable operation this session (config edits, package installs/removals, service changes, deploys, reboots, user/cron/firewall/network changes, restores/migrations), use `append` to add an independent event with summary, symptom, change, verification command/result and outcome. Record failed/partial mutations honestly as well as verified fixes. Read-only checks create no operation event; confirmed diagnostic facts may update timestamped fields. Every field and event must have a full timezone-qualified UTC timestamp, generated by the helper; date-only headings are no longer sufficient. Record before the post-run hook, including when work fails or is interrupted.

## Service and sync incidents
1. Establish the affected device, exact endpoint and failing action. For VPN/tailnet-only services, confirm that VPN is connected on the **affected device** before deep server investigation; successful SSH or HTTP from the agent's machine proves only that machine's access.
2. Check the dependency chain read-only: application and database health, local application HTTP, proxy configuration, then the same endpoint through its intended client-facing route. Do not call a sync/upload incident resolved because a homepage or ping returns 200; those probes do not exercise authentication, upload or background backup.
3. Separate metadata synchronization, asset transfer and post-upload processing. Inspect recent persisted asset timestamps/counts and job state without reading credentials. A completed metadata-sync acknowledgment does not prove any new file uploaded, and an empty queue does not prove the client sent work.
4. Correlate one user-triggered attempt with a bounded live log watch. If routine application logs omit requests, use a short, sanitized request/status capture only when needed. A quiet watch without a confirmed simultaneous attempt is inconclusive. Stop owned watchers when the user cancels or identifies the cause.
5. Rank hypotheses against that evidence. Treat app/server version skew or client network-policy settings as leads until the actual error or supported protocol behavior confirms them; do not upgrade, reset client state or restart healthy services merely to test a guess.
6. Verify recovery with the original action and new persisted data or relevant processing activity. Label processing logs as evidence consistent with uploads, not proof that the entire backup completed. Use `references/service-access-and-sync.md` for the layered probe recipe.

## Timestamped ledger (`<slug>.json`)

Use the bundled helper; never hand-edit timestamps or JSON conflict markers. Connection details are independently timestamped `fields`: `ssh_target`, `user`, `port`, `identity_file`, `bastion_jump`, `vpn_prereq`, `sudo`, `verify_cmd`, and `connection_instructions`. Confirmed diagnostics use named fields or independent events. Each operation is a separate UUID-keyed `events` entry containing summary, symptom, change, verification and outcome. Establish the connection fields before recording remote operations; local work uses the `local` record.

Read `references/private-storage.md` for setup, exact commands, migration and the merge policy. The helper stamps every field/event with full UTC `updated_at`. Never make a stale fact look new by refreshing its timestamp without observing it again. Use timestamped `null` tombstones for removals; do not delete ledger files. Imported history retains original dates and explicitly labels unknown operation times.

## Mandatory post-run hook

Every run, including read-only, failed and partially completed runs, ends through `cleanup`, which executes `scripts/post-run.py` to commit ledger changes, fetch/reconcile, push and verify the exact remote head. Independent facts/events are retained; overlapping facts use the newest timezone-aware timestamp, never blanket ours/theirs. Do not skip the hook because there were no new operations: another host may have updated the ledger. If offline, authentication fails, a hook rejects the commit or an unknown conflict remains, retain local work and report **not synchronized**; retry after recovery, never force-push or claim success. A hard process kill cannot execute a procedural tail; the next run must sync retained changes first.

## Troubleshooting
- Establish the failure layer with a bounded SSH command, VPN/DNS status and `nc -vz <host> <port>`; use the platform's supported connection-timeout option. A responding ping or open port does not prove an SSH session works.
- Auth fail → `ssh -v`, check key path/perms, `ssh-add -l`, server `auth.log`. If verbose output says authentication succeeded but session creation stalls, investigate host pressure or session services instead of replacing keys.
- Bound the entire SSH probe with the tool timeout as well as `ConnectTimeout`; the latter does not cap post-authentication hangs. Keepalive replies likewise do not prove remote command execution.
- After a reboot restores access, inspect the previous boot before declaring a cause; fresh free memory or disk space cannot explain the failed boot. Follow `references/ssh-and-host-pressure.md` for previous-boot OOM evidence, workload attribution and memory accounting.
- Sudo fail → `sudo -n true`, confirm sudo rule in record.
- Persist confirmed diagnostic findings and evidence locations in the server record, distinguishing cause, mitigation and unknowns. Read-only diagnosis does not create a change-operation entry; verified fixes also update Troubleshooting.

## Common mistakes
- Re-asking for host on every run instead of loading the record.
- Storing the record in repo/cwd instead of the stable base.
- Guessing connection flags instead of asking once and persisting.
- Saving secrets into the record instead of refs/paths.
- Finishing a change session without appending the ops log entry.
- Logging read-only checks as operations instead of recordable changes only.

## Framework tail
Before finishing, read `../cleanup/SKILL.md` (relative to this skill's repo directory; fallback `$JP_SKILLS_REPO/skills/cleanup/SKILL.md`) and follow it.
