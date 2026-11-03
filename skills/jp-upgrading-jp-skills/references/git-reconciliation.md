# Explicitly authorized Git reconciliation

Use only after the normal fast-forward upgrade refuses and the user asks you to resolve it. The goal is to preserve both histories and the user's original working changes, not to manufacture a clean tree by deleting work.

## 1. Discover and preserve

Use the resolved checkout as `$repo`. Inspect before mutation:

```sh
git -C "$repo" fetch origin
git -C "$repo" status --short --branch
git -C "$repo" rev-list --left-right --count HEAD...origin/main
git -C "$repo" log --left-right --oneline HEAD...origin/main
git -C "$repo" diff --stat
git -C "$repo" diff --cached --stat
git -C "$repo" stash list
```

Read the actual changed files, including untracked references, and identify overlapping changes. Refuse to continue over an unrelated in-progress merge/rebase. Create a uniquely named backup branch at the original HEAD. Preserve tracked and untracked working changes with `git stash push --include-untracked -m "$label"` only when there are changes; record the exact resulting stash object ID. Preserve ignored files in place and check for path collisions; do not broaden the stash to all ignored files.

Record original status and bytes for later comparison. Never assume `stash@{0}` still identifies your stash after another actor can create one.

## 2. Reconcile semantics, not just markers

Prefer a non-rewriting merge unless the user selected another history policy:

```sh
git -C "$repo" merge --no-commit --no-ff origin/main
```

Resolve each overlap by preserving both independent requirements. For skill updates, keep orchestration additions together with upstream safety gates, exact-head verification, nonterminal outcomes and ownership-safe cleanup; a blanket ours/theirs choice can silently drop either side.

If both branches changed the same release version, combine that version's changelog content into one entry instead of duplicating the heading or inventing a version bump. Preserve historical verification limits; do not relabel old evidence as a fresh test run. Do not edit `VERSION` merely to resolve an upgrade.

## 3. Verify before committing

Stage only the resolved files. Require no unresolved index entries or conflict markers, and run both `git diff --cached --check` and `git diff --check`. Check representative invariants from both branches, not only marker removal.

Run the repository's current documented checks. For changes involving the Startup companion, use its frozen dependency install and the lanes declared by its CI workflow:

```sh
bun install --cwd extensions/startup --frozen-lockfile
bun run --cwd extensions/startup typecheck
bun test extensions/startup/tests
PYTHONDONTWRITEBYTECODE=1 python3 -m unittest discover -s extensions/startup/probes -p 'test_*driver.py'
```

Run from the repository root with temporary output directed to the task's scratch space. Re-read the workflow if commands or dependencies have changed. Passing unit/component tests does not establish live installed-runtime readiness. If a lane fails, report the exact failure rather than declaring reconciliation fully verified.

Commit the merge with a message naming the combined intent and checks actually run. Verify `git merge-base --is-ancestor origin/main HEAD`, then retry `git pull --ff-only`; never force-push to clear divergence.

## 4. Restore the user's work and resume the upgrade

Apply the recorded stash object, not a guessed ordinal. Compare restored tracked and untracked file bytes against the stash trees (`git show "$stash_oid:path"` and `git show "$stash_oid^3:path"`) and compare staged/unstaged status with the original. If restoring the original index matters, use `git stash apply --index "$stash_oid"` and verify that layout too.

Drop only your exact stash after successful restoration and verification. Leave unrelated stashes, the safety branch and user edits intact. Original dirty files should remain uncommitted unless the user separately requested their commit.

Resume migration, registry verification and installed-version stamping from the main skill. Report merge commit, checks, installed version, preserved edits and remaining ahead/behind state. Do not push or claim remote synchronization without publication authorization and a remote readback.
