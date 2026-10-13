#!/usr/bin/env python3
"""Run the installed compiled OMP in an isolated deterministic native fixture."""
import argparse
import hashlib
import gzip
import json
import os
from pathlib import Path
import shutil
import subprocess
import time


def acceptance_checks(events: list[dict], report: dict, exit_code: int, role: str, loop: str, denied: bool, health_unchanged: bool, transcripts: list[dict]) -> dict[str, bool]:
    roots = [event for event in events if event["kind"] == "root"]
    batches = [event for event in events if event["kind"] == "batch_settled"]
    providers = [event for event in events if event["kind"] == "provider_context" and event["id"] != "Main"]
    children = batches[0]["children"] if len(batches) == 1 else []
    ids = {child["id"] for child in children}
    wakes = [event for event in events if event["kind"] == "wake_result"]
    revived = [event for event in events if event["kind"] == "revived_settled"]
    reads = {event["actor"]["id"] for event in events if event["kind"] == "tool_result" and event["toolName"] == "read" and not event["isError"] and '"healthy":true' in str(event["content"])}
    yields = {event["actor"]["id"] for event in events if event["kind"] == "tool_result" and event["toolName"] == "yield" and not event["isError"]}
    denied_writes = {event["id"] for event in providers if any(message.get("toolName") == "write" and message.get("isError") is True and "Tool write not found" in str(message["content"]) for message in event["context"]["messages"])}
    denied_spawns = {event["id"] for event in providers if any(message.get("toolName") == "task" and message.get("isError") is True and "Tool task not found" in str(message["content"]) for message in event["context"]["messages"])}
    initial = [event for event in providers if event["count"] == 1]
    synthetic = [event for event in providers if event["count"] == 2]
    resumed = [event for event in providers if event["id"] == report.get("nativeId") and event["count"] in {6, 7, 8, 9}]
    def projected(event: dict) -> bool:
        projection = next((message["content"] for message in event["context"]["messages"] if message["role"] == "developer" and isinstance(message["content"], str) and message["content"].startswith("STARTUP_NATIVE_ACTOR=")), "")
        return projection == f'STARTUP_NATIVE_ACTOR={event["id"]}\n{role}\n{loop}' and event["roleHash"] == hashlib.sha256(role.encode()).hexdigest() and event["loopHash"] == hashlib.sha256(loop.encode()).hexdigest()
    return {
        "native_completion": report["status"] == "COMPLETE" and exit_code == 0,
        "ordinary_batch_delegation": sum(event["kind"] == "task_wrapper" for event in events) == 1 and any(event["kind"] == "task_delegate_result" and len(event["result"]["details"]["progress"]) == 6 for event in events),
        "six_actual_child_bindings": len(ids) == 6 and all(child["sessionId"] and child["sessionFile"] and child["lifecycle"].get("acceptedAt") for child in children),
        "native_root_correlation": len(roots) == 1 and roots[0]["sessionId"] == roots[0]["registrySessionId"] and len(children) == 6 and all(child["parentId"] == roots[0]["actor"]["id"] for child in children) and len(transcripts) == 6 and all(transcript["header"].get("parentSession") == roots[0]["sessionFile"] for transcript in transcripts),
        "canonical_initial_preload": len(initial) == 6 and all(projected(event) and role.strip() in "\n".join(event["context"]["systemPrompt"]) for event in initial),
        "canonical_synthetic_context": len(synthetic) == 6 and all(projected(event) and any(message["role"] == "developer" and "Reminder 1 of 3" in str(message["content"]) for message in event["context"]["messages"]) for event in synthetic),
        "canonical_revived_and_followup_context": len(resumed) == 4 and all(projected(event) for event in resumed),
        "native_yield_and_idle": ids == yields and bool(ids) and all(any(event["kind"] == "registry_event" and event["id"] == child_id and event["status"] == "idle" for event in events) for child_id in ids),
        "native_park_and_same_child_revival": any(event["kind"] == "parked" for event in events) and len(revived) == 1 and revived[0]["originalSessionId"] == revived[0]["sessionId"] and revived[0]["changedSessionInstance"] and any(event["kind"] == "second_assignment_settled" and event["id"] == revived[0]["id"] for event in events),
        "native_wake_receipts": len(wakes) == 2 and [wake["result"]["details"]["message"]["receipts"][0]["outcome"] for wake in wakes] == ["revived", "woken"],
        "restricted_health_reads": ids == reads and bool(ids) and health_unchanged and all({tool["name"] for tool in event["context"]["tools"]} == {"read", "yield"} for event in providers),
        "unsupported_mutation_and_delegation_denied": ids == denied_writes == denied_spawns and bool(ids) and not denied,
        "registry_singleton": len(roots) == 1 and roots[0]["singleton"],
        "managed_timers": any(event["kind"] == "managed_timers" and event["intervalTicks"] >= 2 for event in events),
        "bun_sqlite": any(event["kind"] == "managed_timers" and event["sqlite"] == {"value": 1} for event in events),
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--workspace", required=True, type=Path)
    parser.add_argument("--evidence", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    workspace = args.workspace.resolve()
    if not workspace.is_relative_to(repo / ".superpowers/sdd/2026-10-13-startup-v6"):
        raise ValueError(f"Probe workspace must be under this plan: {workspace}")
    workspace.mkdir(parents=True, exist_ok=False)
    agent_dir = workspace / "agent-data"
    cwd = workspace / "cwd"
    agents = cwd / ".omp" / "agents"
    agent_dir.mkdir()
    agents.mkdir(parents=True)
    role_path = repo / "skills/startup-role-devops/SKILL.md"
    role = role_path.read_text()
    design = (repo / "docs/superpowers/specs/2026-10-13-startup-v6-design.md").read_text()
    loop = design.split("**Canonical prompt text to add through the shared loop skill:**", 1)[1].split("```text\n", 1)[1].split("```", 1)[0].rstrip("\n")
    (agents / "startup-probe-devops.md").write_text(
        '---\nname: startup-probe-devops\ndescription: Isolated local health fixture\n'
        'model: startup-probe/offline\ntools: [read]\nblocking: false\nread-summarize: false\n---\n' + role
    )
    health_path = cwd / "health.json"
    health_path.write_text('{"target":"local-health","healthy":true,"revision":1}\n')
    config_path = workspace / "config.yml"
    config_path.write_text(
        'task:\n  batch: true\n  agentIdleTtlMs: 0\n  speculativeLaunch: false\n'
        'async:\n  enabled: true\nproviders:\n  cacheWarming: false\n'
        'memories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n'
    )
    omp = shutil.which("omp")
    if omp is None:
        raise FileNotFoundError("Installed compiled omp executable unavailable")
    version = subprocess.check_output([omp, "--version"], text=True).strip()
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "LOGNAME"
    }}
    env.update({
        "PI_CODING_AGENT_DIR": str(agent_dir),
        "STARTUP_PROBE_ROLE": str(role_path),
        "STARTUP_PROBE_EVENTS": str(workspace / "events.jsonl"),
        "STARTUP_PROBE_REPORT": str(workspace / "report.json"),
        "STARTUP_PROBE_HEALTH": str(health_path),
        "STARTUP_PROBE_DENIED_PATH": str(cwd / "denied-mutation.txt"),
    })
    command = [omp, "--mode", "rpc", "--no-ui", "--cwd", str(cwd), "--config", str(config_path),
               "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--no-title",
               "--tools", "task,read,write", "--extension", str(Path(__file__).with_name("native-feasibility.ts")),
               "--model", "startup-probe/offline", "--thinking", "off", "--auto-approve"]
    with (workspace / "stdout.jsonl").open("w") as stdout, (workspace / "stderr.txt").open("w") as stderr:
        process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True)
        if process.stdin is None:
            raise RuntimeError("RPC stdin pipe missing")
        process.stdin.write(json.dumps({"id": "native-gate", "type": "prompt", "message": "/startup-native-probe"}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 110
        while not (workspace / "report.json").exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.1)
        if process.poll() is None and not (workspace / "report.json").exists():
            process.terminate()
        process.stdin.close()
        try:
            exit_code = process.wait(timeout=15)
        except subprocess.TimeoutExpired:
            process.kill()
            exit_code = process.wait()
    events_path = workspace / "events.jsonl"
    events = [json.loads(line) for line in events_path.read_text().splitlines()] if events_path.exists() else []
    report_path = workspace / "report.json"
    report = json.loads(report_path.read_text()) if report_path.exists() else {"status": "FAIL", "error": "Native report missing"}
    transcripts = []
    for event in events:
        if event["kind"] == "batch_settled":
            for child in event["children"]:
                native_file = Path(child["sessionFile"])
                content = native_file.read_bytes()
                records = [json.loads(line) for line in content.splitlines()]
                header = next(record for record in records if record["type"] == "session")
                transcripts.append({"id": child["id"], "header": header,
                                    "sha256": hashlib.sha256(content).hexdigest(), "records": records})
    denied = (cwd / "denied-mutation.txt").exists()
    health_unchanged = health_path.read_text() == '{"target":"local-health","healthy":true,"revision":1}\n'
    checks = acceptance_checks(events, report, exit_code, role, loop, denied, health_unchanged, transcripts)
    status = "PASS" if all(checks.values()) and version == "omp/18.8.9" else "FAIL"
    evidence = {
        "gateVersion": 1, "status": status, "checks": checks, "installedVersion": version, "executable": omp,
        "officialSourceCommit": "fa5ff4a3a977a28b93d025f4cf50f046e019f18c",
        "command": command, "exitCode": exit_code, "stderr": (workspace / "stderr.txt").read_text(),
        "report": report, "roleSource": "skills/startup-role-devops/SKILL.md",
        "roleSha256": hashlib.sha256(role.encode()).hexdigest(), "loopSha256": hashlib.sha256(loop.encode()).hexdigest(),
        "deniedMutationExists": (cwd / "denied-mutation.txt").exists(),
        "healthUnchanged": health_path.read_text() == '{"target":"local-health","healthy":true,"revision":1}\n',
        "events": events, "nativeTranscripts": transcripts, "rpcOutput": (workspace / "stdout.jsonl").read_text(),
    }
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_bytes(gzip.compress((json.dumps(evidence, ensure_ascii=True) + "\n").encode(), mtime=0))
    print(json.dumps({"status": status, "checks": checks, "installedVersion": version, "exitCode": exit_code, "report": report,
                      "eventCount": len(events), "evidence": str(args.evidence)}))
    return 0 if status == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
