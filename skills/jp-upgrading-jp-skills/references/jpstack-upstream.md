# jpstack upstream reconcile

`<repo>/jpstack/` is a vendored, harness-neutral copy of poteto's pstack (`cursor/plugins`, `pstack/`). It is plain files in jp-skills: not a submodule, not a nested repo, and no registry link ever points at an upstream checkout. The upstream clone under `<home>/cache/jpstack-upstream/` is a read-only reference that `jpstack/scripts/upstream.py` diffs against. A `git pull` there changes nothing that is installed.

`jpstack/UPSTREAM.json` pins the last reconciled upstream commit and the mapping policy: `include` (vendored paths), `exclude` (upstream paths we drop, each with a reason) and `rename`.

## Every upgrade

Run from the jp-skills checkout after its own pull, before relink:

1. `python3 jpstack/scripts/upstream.py fetch`. A network failure is not fatal: report it, skip to relink, and leave the pin unchanged.
2. `python3 jpstack/scripts/upstream.py status`. Zero changes → done, go to relink.
3. `python3 jpstack/scripts/upstream.py merge`. It three-way merges each mapped file (base = pinned upstream, theirs = upstream HEAD, ours = jpstack), adds new upstream files and deletes files we never edited. Note the HEAD commit it prints.
4. Resolve every `conflict*` line it prints. Keep our harness-neutral wording and take upstream's new substance. `conflict-delete`: upstream deleted a file we edited; delete it unless our edit is still referenced. `conflict-local-delete`: we deleted a file upstream still edits; keep it deleted unless the upstream change is a reason to restore it.
5. Remove Cursor-specific residue from everything the merge touched, by the rules below. `python3 jpstack/scripts/upstream.py check` must print `jpstack is clean`.
6. `REVIEW-ONLY` lines are upstream changes to excluded skills. Read each diff (`git -C <home>/cache/jpstack-upstream diff <pinned> <head> -- pstack/<path>`). For `correct` and `typescript-best-practices`, fold any real improvement into `jp-correct` / `jp-typescript-best-practices`. A new upstream skill that duplicates a jp- skill or is Cursor-only goes into `exclude` with a reason.
7. `python3 jpstack/scripts/upstream.py pin <head>`, then `python3 -m unittest discover -s tests`.
8. Commit locally on the checkout's branch: `jpstack: sync upstream pstack <head:12>`, listing conflicts resolved and review-only skills folded. This does not authorize pushing; report the unpushed commit unless the user asked to publish.

If the checkout is not yours to commit to (dirty with another owner's work, detached, or a release in progress), stop after `status`, report the pending upstream range, and leave the pin unchanged.

## De-Cursor rules

`jpstack/docs/harness.md` is the vocabulary. Edit line-locally and keep upstream wording elsewhere. Every unnecessary edit is a future conflict.

- Tools and subagent fields use the neutral names in harness.md (subagent tool, read-only subagent, isolated worker, ask the user). No `Task`, `AskQuestion`, `generalPurpose`, `readonly: true`, `environment: "cloud"`, `cloud_base_branch`.
- Storage goes to the jp-skills home: `<home>/jpstack/models.md` (never `~/.cursor/rules/*.mdc`), `<home>/tmp/jpstack/` for scratch. Project skills go in `.claude/skills/` or `.agents/skills/`. Transcripts follow harness.md.
- `pstack` → `jpstack`, `setup-pstack` → `setup-jpstack`. Install and update instructions point to `jp-upgrading-jp-skills`.
- Cursor-only features (Automations, routines, webhooks, cloud agents, Custom Modes, Plan Mode, Bugbot as a product, the Agents Window) → the companion or neutral equivalent in harness.md, else delete the clause.
- Companion skills from other Cursor plugins map per harness.md's Companion skills table.
- Code under `skills/*/scripts/` keeps its logic; fix only paths and package names.

## Retiring a pstack install

Check on every upgrade; each step is a no-op once done.

1. Model choices: if `~/.claude/rules/pstack-models.md` or `~/.cursor/rules/pstack-models.mdc` exists and `<home>/jpstack/models.md` does not, copy its role lines into `<home>/jpstack/models.md` (drop frontmatter), then delete the old rule file. Claude Code loads every file in `~/.claude/rules/` into each session, so a stale pstack rule keeps steering models.
2. Claude Code plugin: if `claude plugin list` shows `pstack@…`, run `claude plugin uninstall pstack@<marketplace>`. Remove that marketplace (`claude plugin marketplace remove <name>`) only when no other installed plugin comes from it.
3. Registry links into a pstack install are replaced or removed by `relink.py`. Never delete a pstack checkout you did not create; report its path so the user can remove it.
