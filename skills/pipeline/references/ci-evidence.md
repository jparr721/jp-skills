# Acquiring and attributing CI evidence

Use when CI-only verification produces generated files, publication measurements, mutation proofs or real-data QA artifacts. This procedure collects evidence; it never grants source-edit, workflow-publication or deployment authority.

## 1. Inspect the exact check graph

```sh
gh pr view <pr> --repo <owner/repo> \
  --json headRefOid,baseRefName,state,statusCheckRollup
gh run view <run> --repo <owner/repo> \
  --json headSha,status,conclusion,jobs,url
gh api repos/<owner/repo>/actions/runs/<run>/artifacts
```

Save raw responses outside the source tree. Parse job and step results separately. Confirm the run belongs to the intended PR/head before collecting artifacts; an older successful run is not a current gate. Reuse these exact-head responses across foreground and scheduled management rather than repeatedly listing every job.

When GitHub reports an exhausted quota, inspect the authoritative budget once with `gh api rate_limit --jq '{core:.resources.core,graphql:.resources.graphql}'`, record the affected resource and reset epoch, and calculate the next permitted acquisition time with a tool. Share that hold with all task managers and suspend affected requests until reset; do not rotate accounts or credentials to evade the limit. Continue source inspection, review and preparation using retained evidence. After reset, fetch only the missing current-head logs/artifacts and preserve their receipts.

Identify the actual failing step, not only the aggregate merge gate. If an HTTP fixture passed and a subsequent contract-budget check failed, retain the fixture result without reporting the entire job as passed. Likewise, distinguish an expected executed mutation failure from the restored-source run that must pass afterward.

## 2. Acquire artifacts and logs without changing source

```sh
gh run download <run> --repo <owner/repo> --dir <durable-run-dir>/ci/<run>/artifacts
gh run view <run> --repo <owner/repo> --log-failed
```

Before downloading, acquire a task-scoped acquisition lease keyed by repository/run/attempt and inspect any existing artifact receipt. Reuse a complete, independently validated extraction instead of downloading it again. If an extraction reports existing files, preserve that command's failure separately and validate the existing bytes; a local extraction collision is not a failed CI check. If files are incomplete, acquire only the missing artifacts into a separate staging directory, validate them, then publish the completed extraction and receipt under the lease. Never delete another manager's active download or merge partial directories blindly.

Preserve command exits and full outputs in files; return bounded summaries to the manager. If logs are unavailable because the workflow is still running, retain that retrieval result and retry after the workflow completes. Do not cancel a healthy run merely to obtain logs. A permission or content-safety refusal is a different boundary: preserve it and use the approved remediation path, not flags or alternate acquisition surfaces that evade it.

## 3. Check source and byte provenance

1. Establish the expected artifact inventory from the workflow and collector contract before checking hashes or SHAs. Assert required artifact classes are present, expected role identities are unique and complete, and required manifests/transcript/screenshot collections are nonempty. Do not treat `for file in glob(...)` without a cardinality assertion as verification: a missing directory makes every per-file assertion silently disappear.
2. Compare the PR head, run metadata, every recorded checkout SHA, and embedded source identifiers in generated/measurement/QA artifacts. Check every role artifact and child transcript binding rather than trusting only the top-level manifest. Verify generated-file checksums and each raw transcript hash against its manifest with code, then resolve every declared slide asset and assert it exists. Record the observed counts and identities in the acquisition receipt; file existence does not replace visual inspection when claiming screenshot readability.
3. Treat GitHub event SHA, PR merge-ref SHA and checked-out source SHA as distinct until their relationship is established. Checking out the PR head does not necessarily change event-derived environment metadata used by a collector.
4. Preserve original artifacts when labels disagree. Do not edit their embedded identifiers or claim a matching top-level manifest cures a conflicting child artifact. Correct the collector's attribution and obtain fresh evidence when exact-head proof is required.
5. Keep genuine generated output, its patch, toolchain receipt and measurement JSON together. A checksum alone authenticates neither execution nor source identity.

For a new collector, record `git rev-parse HEAD` after checkout and validate the actual recorded source against the intended revision. Use an application-specific source variable where appropriate rather than assuming a reserved event variable was overridden successfully.

Pass collector metadata through the repository's sanctioned configuration boundary. When direct environment access is lint-forbidden, use strict named CLI arguments with runtime schema validation for artifact directory, source SHA, run ID and attempt; quote every argument in the workflow caller. Do not swap `process.env` for another runtime's environment alias or add a suppression, because that evades rather than satisfies the boundary. Preserve any original hook failure and require an actual successful normal-hook retry.

Render captured HTTP transcripts only after validating their source binding, and HTML-escape any content inserted into a report. Label the rendering as captured API evidence, not product UI or deployed availability; preparing a deck from premerge artifacts does not satisfy final-head or postmerge QA.

## 4. Attribute exits through the canonical runner

Keep these facts separate: case counts, JUnit failures/errors/skips, child process exit, coordinator exit, workflow-step conclusion and whole-job conclusion. A test summary can show no failed assertions while the process still exits nonzero. Inspect the repository's documented runner and lifecycle semantics before changing invocation or normalization; do not add `|| true`, broad continue-on-error or special-case success for an unexplained code.

For regression mutation proof, require evidence that the intended case actually executed and failed for the intended diagnostic, then restore the original source and require the chosen verification gate. A checkout or workflow rejection is not behavioral RED.

## 5. Integrate only after the review freeze ends

Download and inspect artifacts while reviewers hold a pushed head immutable, but do not apply generated files, change baselines or advance/rebase that head until the round closes. After closure, apply genuine output through the assigned writer, commit with normal hooks, push, and require fresh qualification on the resulting head.

When the broad run uses a newer target merge than the focused branch-head run, inspect the real target delta before blaming test order or changing ceilings: shared schemas and tool discovery inputs can legitimately change the published contract. Record the target SHA and relevant diff. If reconciliation is required, close the review freeze first, verify the live target still matches the inspected SHA, and integrate using the repository's history convention. For a merge-commit workflow, commit the bounded repair with normal hooks, use `git merge --no-commit <inspected-target-sha>`, inspect the full merge index, and create the ordinary merge commit before pushing the coherent head. Stop on conflicts or target drift; preserve both commit SHAs and merge parents/tree, and require fresh exact-head CI. Do not push an interim repair graph whose measurements assume target changes not yet integrated.

Use exact measured values for a deliberately changed publication contract and retain the reason for the delta. If a focused collector passes while the full suite reports different sizes for the same apparent source, compare the actual source revision, runner, tool discovery inputs, environment, test order and shared mutable state before deciding which contract is authoritative. Keep both original receipts; a narrow pass is not permission to relax the broad gate. Do not write a presumed root cause into the record before it is established.

Never invent measurements, pad ceilings to hide growth, or describe baseline adjustment as an executed test. Final reporting separates source review approval, CI qualification, source merge and deployed availability.

## 6. Acquire postmerge proof without restarting healthy runs

After the merge readback, discover the existing exact-source workflows:

```sh
gh run list --repo <owner/repo> --commit <merge-sha> --limit 20 \
  --json databaseId,name,headSha,event,status,conclusion,url
```

Identify the expected qualification and main-check workflows by name, event and exact SHA.
Reuse automatic push runs and their current attempt; dispatch manually only when the required
run is genuinely absent and the workflow's supported inputs and authority are established.
Do not treat a run-level `queued` projection as proof that no child job has started: inspect
jobs when resolving an apparent stall, and keep queued/running work pending rather than
canceling it to force a fresh run.

Acquire completed artifacts under the same repository/run/attempt lease used premerge. Verify
the expected nonempty artifact inventory, every source binding, transcript hash and role set
against the actual merge SHA; never relabel premerge screenshots as postmerge evidence.
For rendered API evidence, verify the report escapes transcript content, inspect every claimed
capture for readability, and label it as an API report rather than product UI. If a self-contained
HTML deck embeds PNGs, compare the decoded image bytes with the verified source PNGs. Copy
out the deck, linked assets and evidence, then verify destination hashes before delivery.

Record main CI, qualification, image release and live read smoke independently. Successful
image publication does not establish rollout health or that the endpoint advertises the new
contract. Complete source-through-main work with that limitation explicit when deployment is
outside scope; do not initiate credential setup, customer writes or deployment remediation
merely to turn a separate availability field green.
