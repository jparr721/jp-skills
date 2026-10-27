# Private repository storage

## Setup and layout

Assume `gh` is available and authenticated. Use it directly; do not add installation/login/token questions or delegate repo creation to the user. Ask once: “What private GitHub repository should store your jp-skills data? Default: `jp-skills-storage`; an `OWNER/REPO` is also accepted.” If the user already chose or authorized the default, proceed without re-asking. Persist that choice in `<home>/storage.json`; later runs reuse it.

Resolve the helper relative to the loaded skill: `../cleanup/scripts/storage.py`, or `<jp-skills repo>/skills/cleanup/scripts/storage.py`. The helper needs Python 3.10+, git and authenticated `gh`. Python commands below run through the harness's terminal tool; `<storage.py>` means that resolved absolute script path, not a script generated in the current directory.

```sh
python3 <storage.py> setup --repo <chosen-name-or-owner/repo>
python3 <storage.py> status
python3 <storage.py> sync
```

A bare name resolves through `gh api user --jq .login`. Setup uses `gh repo create <owner/repo> --private --add-readme` only for a missing repository, otherwise `gh repo clone`. It reads back `nameWithOwner,isPrivate,defaultBranchRef` and refuses a public repo or mismatched origin. Validate **every effective fetch and push URL**, including Git URL rewrites and all `remote.origin.pushurl` entries, against the selected private repo before publication; a private fetch origin alone does not protect the push destination. A real CLI/auth/permission failure is reported as a blocker, never an excuse to create public storage, rotate credentials or invent success.

```text
<canonical home>/
  storage.json                     # chosen repo, clone_path, branch, updated_at
  storage-last-sync.json            # verified commit, repo, branch, updated_at
  storage/                         # private git clone, not the public skills repo
    server-maintenance/
      ledger/
        ledger.json                # timestamped folder manifest; reserved name
        <server-slug>.json          # timestamped connection fields and operation events
    <future-skill>/ledger/          # same schema; --namespace opts into other skills
  servers/*.md                     # legacy migration sources; no new writes
  tmp/server-maintenance/           # local scratch, never committed
```

## All new information has a timestamp

Use `put` for one current fact and `append` for one independent operation. The helper assigns UTC timestamps with microsecond precision; every fact/event is a `value` plus `updated_at`. An event can contain multiple related details under that one observation timestamp. Include `occurred_at` separately if the action happened earlier; do not confuse recording time with execution time. No raw untimestamped ledger entries.

```sh
python3 <storage.py> put --server aspen --key ssh_target --value-json '"jsp@aspen"'
python3 <storage.py> put --server aspen --key verify_cmd --value-json '"ssh jsp@aspen true"'
python3 <storage.py> append --server aspen --value-json '{"summary":"Restart nginx","symptom":"502 after deploy","change":"Corrected proxy config and restarted nginx","verify":{"command":"systemctl is-active nginx","result":"active"},"outcome":"verified"}'
python3 <storage.py> put --server aspen --key obsolete_note --value-json 'null'
```

Store each independently changing connection setting as its own key. Replace a confirmed diagnosis only when new evidence supersedes it. Preserve original event IDs when correcting an event; prefer a new correction event referencing the old ID so history remains auditable. Do not refresh timestamps merely because a record was read, copied, rendered or synchronized. `null` is a timestamped tombstone; physical field/file deletion would let an older clone resurrect data.

## Upgrade migration (also first-use migration)

1. Even on an otherwise skill-only upgrade, check storage migration readiness. If `storage.json` is missing, ask for the repository name/default, then the **agent** runs setup with `gh`. Never tell the user to create it manually. If configured, reuse it and sync before importing. A declined migration leaves sources unchanged and migration explicitly pending.
2. Inventory `<home>/servers/*.md` and `~/.local/share/server-maintenance/servers/*.md`, including `.ops.md`. Review them for credentials/private key material before importing; redact secrets locally with authorization, retaining password-manager references instead. Do not publish source contents to chat or the public skills repo.
3. Run `python3 <storage.py> migrate`. It imports both locations directly without deleting/moving/overwriting sources. Stable import IDs deduplicate identical files across retries and hosts; changed source content becomes a separate import. Full original text and date-only history are retained in timestamped import events. Simple `- field: value` connection lines become independently timestamped fields; newer ledger facts win.
4. Imported event `updated_at` is the import time, **not** an invented operation time. Source file mtime is saved and used as a clearly labeled legacy field-time fallback; `occurred_at` remains `null` when unknown. Original textual dates remain in `content`. For files containing historical bullet fields, inspect the resulting current fields and correct them from actual verified evidence; do not treat an old log bullet as a current connection setting.
5. Verify every inventoried source file has a matching `legacy-import` event with equal `source_name` and `content`; count/dedupe in code, never infer success from a command exit alone. Read back connection fields, note any ambiguous timestamps, and repeat migration: `imported_files` must be zero before leaving the sources read-only.
6. Run the post-run hook or `sync`. Require `storage-last-sync.json` to identify the selected repository/branch and require `git ls-remote origin refs/heads/<branch>` to equal the local commit. Only then mark `storage_migration` complete in `<home>/config.json` with `repo`, `completed_at` and verified `commit`; preserve other config keys. A version stamp alone is not a storage migration receipt. Keep legacy sources as recovery copies; no more writes there.

## Post-run reconciliation

The shared `cleanup` tail invokes `python3 <cleanup skill>/scripts/post-run.py` on **every** skill run once storage is configured, even when read-only, failed or unchanged. This is the portable post-run hook; it does not silently install harness-specific global hooks or modify unrelated profiles. An unconfigured unrelated skill run is a no-op, not implicit consent to create a repository. Server maintenance and upgrade perform the setup decision explicitly.

The helper serializes local writers/sync with `<home>/.storage.lock`; the owner has a PID and creation timestamp. A busy lock is a retryable condition. On stale-lock recovery, verify the owning process is gone before removing only this lock. It never locks another machine; git fetch/merge/push retries reconcile those writers.

- Semantically reconcile staged ledger content with working-tree content before staging; never overwrite a staged-only newer fact. Discover ledgers independently of Git ignore rules, reject ignored ledgers visibly, and require every discovered ledger to be tracked before issuing a receipt. Then commit changed ledgers, fetch the selected branch, and semantically reconcile **all** matching JSON ledgers, even if Git reports a clean textual merge.
- Two clients can initialize an existing empty private repo independently: allow unrelated histories only for validated ledger-only histories from the selected origin, then apply the same timestamp merge. Unrelated histories containing unknown files need explicit reconciliation.
- Preserve distinct keys and all independent event IDs. For the same key/ID, compare timezone-aware timestamps and retain the newest value; equal-time disagreements use canonical JSON order for deterministic convergence. Earlier versions remain in Git history. Maintain trustworthy host clocks; timestamps are not causal/vector clocks.
- Retry rejected non-fast-forward pushes against a fresh fetch, up to five attempts. Never force-push, reset away local commits, or blanket-pick ours/theirs.
- Honor normal repository hooks and inspect the committed result, not just the previously staged files. Unexpected non-ledger hook changes or invalid committed ledgers create a timestamped Git-local `jp-skills-storage-blocked.json` marker; retries remain blocked until the offending commit/history is explicitly repaired and the marker is deliberately cleared. Never merely delete the marker to publish rejected history. Unsupported schema, missing timestamps, physical ledger deletion, symlinked paths, unrelated dirty files or non-ledger conflicts fail visibly without discarding local work. Reconcile an unknown non-ledger conflict explicitly; do not claim the automatic ledger merge can infer arbitrary future formats.
- Read back the exact remote branch SHA after push, require a clean working tree, and write a timestamped local receipt only on success. No changes means no empty commit, but still fetch/reconcile/push/read back.
- If offline or blocked, retain timestamped local changes/commits, report **not synchronized**, and rerun the hook after recovery. Do not substitute stale receipt data for a successful current run. If a process is killed before the portable tail runs, the next maintenance run syncs pending work first.

## Verification

Run the offline tests from the jp-skills checkout with `python3 -m unittest discover -s tests -v`. Git integration tests use real bare remotes and divergent clones; only GitHub availability/privacy calls are mocked. For a real setup, additionally read `gh repo view <owner/repo> --json nameWithOwner,isPrivate,url` and verify remote ledger contents and the branch SHA after the hook.
