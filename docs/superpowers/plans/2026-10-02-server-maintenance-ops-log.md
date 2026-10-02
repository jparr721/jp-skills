# Server Maintenance Operations Log Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a per-server operations log to the `server-maintenance` skill so one-off fixes on a server are recorded as compact entries before the agent finishes.

**Architecture:** Single-file prose edit to `server-maintenance/SKILL.md` (description, When to Use, Stable home, Flow RECORD step, Operations log section, Common mistakes), plus release wiring (README row, CHANGELOG entry, VERSION bump 1.3.0 → 1.4.0). Markdown-only; verification is read-through plus link/shape checks, not tests.

**Tech Stack:** Markdown skill file following the repo's SKILL.md shape (frontmatter `name` + `description`, `##` sections, Framework tail).

## Global Constraints

- Skill instructions are generic actions; each harness maps dispatch/ask/read/search/edit/run to native tools.
- Every skill ends with the Framework tail pointing at `../shared/cleanup.md`; RECORD runs before the tail, the tail itself is untouched.
- Canonical home is `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (Windows `%APPDATA%\jp-skills`); nothing under repo/cwd.
- Never store secrets: key paths not key material, password-manager refs not passwords — ops entries carry refs/paths only.
- `VERSION` at repo root is the version source of truth; behavior additions land in `CHANGELOG.md` with a minor bump.

---

### Task 1: Edit `server-maintenance/SKILL.md`

**Files:**
- Modify: `server-maintenance/SKILL.md` (6 surgical edits, lines noted against `main`)
- Test: read-through against the spec `docs/superpowers/specs/2026-10-02-server-maintenance-ops-log-design.md` (every Design bullet traceable to a skill section)

**Interfaces:**
- Consumes: spec decisions (Discovery, Storage, Trigger list/entry shape/close-out), current skill text (`server-maintenance/SKILL.md` on `main`).
- Produces: the edited skill file Tasks 2–3 reference.

- [ ] **Step 1: Update the frontmatter description**

In `server-maintenance/SKILL.md` line 3, replace:

```markdown
description: Use when doing server maintenance, patching, rebooting, or debugging a remote host, or when connection details for a named server need lookup or saving
```

with:

```markdown
description: Use when doing server maintenance, patching, rebooting, or debugging a remote host, making changes, fixing issues, or recording completed operations on a named server, or when connection details for a named server need lookup or saving
```

- [ ] **Step 2: Extend When to Use**

In the `## When to Use` list (after the SSH-fails line), insert:

```markdown
- After any change/fix on a known server: record it in the operations log before finishing.
```

- [ ] **Step 3: Name the ops file in Stable home**

At the end of the `## Stable home` first paragraph (line 18), append a second sentence so the paragraph reads:

```markdown
Canonical home: `$JP_SKILLS_HOME`, else `$XDG_CONFIG_HOME/jp-skills`, else `~/.config/jp-skills` (XDG default; Windows `%APPDATA%\jp-skills`). Records live in `<home>/servers/` as `<slug>.md`, slug = lowercase server name with `[^a-z0-9-]` collapsed to `-`. Operations logs live beside records as `<slug>.ops.md` (same `<home>/servers/` dir). Scratch goes in `<home>/tmp/server-maintenance/`.
```

- [ ] **Step 4: Add the RECORD step to Flow**

After Flow step 4 (the `On failure → Troubleshooting` line), append step 5 verbatim:

```markdown
5. Record: for each recordable operation this session (config file edits, package installs/removals, service start/stop/restart/enable, deploys/releases, reboots, user/cron/firewall/network changes, restores/migrations), append one compact entry to `<slug>.ops.md` — create the file with a `# <server name> — operations log` header on first use. Read-only checks (disk, logs, `systemctl status`) record nothing. Entry shape is `## YYYY-MM-DD — <one-line summary>` plus `- symptom:`, `- change:`, `- verify: <cmd> → <result>` lines; refs/paths only, never secrets. Record runs before the Framework tail.
```

- [ ] **Step 5: Add the Operations log section**

After the `## Record schema` code block (before `## Troubleshooting`), insert verbatim:

````markdown
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
````

- [ ] **Step 6: Extend Common mistakes**

Append two bullets to `## Common mistakes`:

```markdown
- Finishing a change session without appending the ops log entry.
- Logging read-only checks as operations instead of recordable changes only.
```

- [ ] **Step 7: Read back and trace the spec**

Run: `read server-maintenance/SKILL.md` (full file).
Expected: description carries fix/change/record symptoms → Discovery; `<slug>.ops.md` beside `<slug>.md`, canonical home unchanged → Storage; recordable list + read-only exclusion + compact entry + RECORD-before-tail → Close-out. No `JP_SKILLS_PATH`, no repo/cwd paths, no secret material.

- [ ] **Step 8: Commit the skill edit**

```bash
git add server-maintenance/SKILL.md
git commit -m "feat: record server operations to per-server ops log"
```

### Task 2: Wire README, CHANGELOG, VERSION

**Files:**
- Modify: `README.md` (Operations table, `server-maintenance` row + Versioning line)
- Modify: `CHANGELOG.md` (new `## [1.4.0]` entry on top; sibling `## [1.3.0]` Changed block untouched)
- Modify: `VERSION` (`1.3.0` → `1.4.0`)
- Test: `grep -r "ops.md" --include="*.md" .` lists the skill section plus the changelog entry

- [ ] **Step 1: Update the README row**

In `README.md` line 42, replace the `server-maintenance` row with:

```markdown
| [`server-maintenance`](server-maintenance/SKILL.md) | Maintenance on a named remote server — updates, reboots, disk/service/log checks. Resolves the server to a stable on-disk record under the canonical home, asks once for connection instructions when missing. Records completed operations to a per-server log. | Mutates remote host |
```

In `README.md` Versioning section (line 52), replace `(currently 1.2.0)` with `(currently 1.4.0)`.

- [ ] **Step 2: Add the CHANGELOG entry**

At the top of `CHANGELOG.md`, after line 3 (the `` `VERSION` ... `` paragraph) and before the sibling `## [1.3.0]` block, insert:

```markdown
## [1.4.0] - 2026-10-02

### Added

- `server-maintenance` operations log: completed operations (config edits, installs, service changes, deploys, reboots, user/cron/firewall/network changes, restores/migrations) append one compact entry (symptom / change / verify) to `<home>/servers/<slug>.ops.md` via a mandatory RECORD step before the cleanup tail. Read-only checks record nothing; connection record and legacy fallback unchanged.
```

- [ ] **Step 3: Bump VERSION**

Replace the content of `VERSION` with:

```text
1.4.0
```

- [ ] **Step 4: Commit the wiring**

```bash
git add README.md CHANGELOG.md VERSION
git commit -m "Wire server-maintenance ops log release (1.4.0)"
```

### Task 3: Verify and link-check

**Files:**
- Test: frontmatter + tail + cross-links (no new files)

**Interfaces:**
- Consumes: Tasks 1–2 outputs.
- Produces: final green state.

- [ ] **Step 1: Verify frontmatter and tail**

Run: `grep -A2 "^---" server-maintenance/SKILL.md | head -5` — expect `name: server-maintenance` and a `description` line containing `recording completed operations`.
Run: `tail -3 server-maintenance/SKILL.md` — expect the Framework tail pointing at `../shared/cleanup.md`.

- [ ] **Step 2: Verify cross-links**

Run: `grep -r "ops.md" --include="*.md" .` — expect exactly: the skill's Stable home / Flow / Operations log mentions and the CHANGELOG entry. No dangling `<slug>.ops.md` references outside those two files.

- [ ] **Step 3: Verify git state (scoped — sibling works elsewhere on `main`)**

Run: `git status --short -- server-maintenance/ README.md CHANGELOG.md VERSION docs/superpowers/plans/2026-10-02-server-maintenance-ops-log.md docs/superpowers/specs/2026-10-02-server-maintenance-ops-log-design.md` — expect clean (no output). Do NOT require a fully clean tree: sibling artifacts (`.superpowers/sdd/2026-10-02-ready-pr-pipin-stall/`, `docs/superpowers/plans/2026-10-02-code-quality-architecture-v2.md`) are untracked and out of scope — leave them alone. Run: `git log --oneline -6` — expect the two build commits on top, in order: wiring (`1.4.0`) then skill edit, above the spec/plan commits.
