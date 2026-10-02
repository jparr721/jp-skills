# Server Maintenance Operations Log — Design

Date: 2026-10-02. Approach A: per-server ops log + mandatory close-out.

## Problem

`server-maintenance` persists only connection instructions + `Troubleshooting`
symptom→fix lines in `<home>/servers/<slug>.md`. One-off fixes made by a
coding agent on a server have no stable record: no what-changed, no verify
result, no per-server history. User suspicion confirmed — no operations store
exists.

## Goal

After any change/fix on a known server, the agent appends one compact entry
to a stable per-server log before finishing. Manual (`use server-maintenance`)
and automatic (description-triggered mid-session) invocation both land in the
same close-out path.

## Non-goals

- No global journal, no history inside the connection record.
- No full command transcripts, no rollback notes, no secret material.
- No change to the connection flow, slug rules, legacy fallback, or cleanup tail.

## Design

### 1. Discovery

- `description` gains fix/change symptoms: `making changes, fixing issues, or
  recording completed operations on a named server`.
- `When to Use` gains: after any change/fix on a known server, record it
  before finishing.
- Manual path preserved: `use server-maintenance` still pulls it explicitly.

### 2. Storage

- New file `<canonical-home>/servers/<slug>.ops.md` beside `<slug>.md`,
  where canonical home = `$JP_SKILLS_HOME`, else
  `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills`
  (Windows `%APPDATA%\jp-skills`). No `JP_SKILLS_PATH` exists; nothing new
  to configure, nothing under repo/cwd.
- First entry creates the file with `# <server name> — operations log`
  header; later entries append.
- Missing connection record follows the existing flow (ask once, write
  `<slug>.md` first) — ops file never created standalone.
- Legacy fallback unchanged: only `<slug>.md` moves from
  `~/.local/share/server-maintenance/servers/`; ops file has no legacy.

### 3. Trigger list, entry shape, close-out

Recordable (one entry each): config file edits, package installs/removals,
service start/stop/restart/enable, deploys/releases, reboots,
user/cron/firewall/network changes, restores/migrations.

Not recordable: read-only checks (disk, logs, `systemctl status`) — no
entry, no noise.

Compact entry:

```markdown
## YYYY-MM-DD — <one-line summary>
- symptom: <what was wrong>
- change: <what was done>
- verify: <cmd> → <result>
```

Secrets rule carries over: refs/paths only, never material.

Mandatory RECORD step before the Framework tail: after the fix is verified,
append the entry, then read `../shared/cleanup.md` and follow it.
`Troubleshooting` in `<slug>.md` stays connection-only; no shared-file
change needed.

## Verification

- Skill edit is prose-only; verification = spec self-review + user spec
  review, then implementation via writing-plans.
- Post-implementation: fresh-context agent asked to fix a server issue
  appends a compact entry to `<slug>.ops.md` without re-asking connection
  details; read-only check appends nothing.
