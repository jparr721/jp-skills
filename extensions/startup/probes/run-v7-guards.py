#!/usr/bin/env python3
import argparse
import hashlib
import json
import os
import re
from pathlib import Path
import shutil
import subprocess
import tempfile
import time


def sha(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_stage(omp: str, repo: Path, workspace: Path, stage: str, module: Path) -> dict:
    work = workspace / stage
    work.mkdir()
    cwd = work / "cwd"
    profiles = cwd / ".omp/agents"
    profiles.mkdir(parents=True)
    agent_dir = work / "agent-data"
    agent_dir.mkdir()
    (profiles / "v7-guard-helper.md").write_text(
        "---\nname: v7-guard-helper\ndescription: Isolated guard fixture\n"
        "model: startup-v7-guard/offline\ntools: [startup_guard_probe]\nblocking: true\nread-summarize: false\n---\nHELPER_NATIVE_GUARD\n"
    )
    config = work / "config.yml"
    config.write_text("task:\n  batch: true\n  speculativeLaunch: false\nasync:\n  enabled: true\nproviders:\n  cacheWarming: false\nmemories:\n  enabled: false\nmcp:\n  enableProjectConfig: false\n")
    env = {key: value for key, value in os.environ.items() if key in {
        "PATH", "HOME", "TMPDIR", "LANG", "LC_ALL", "TERM", "SHELL", "USER", "LOGNAME"
    }}
    env.update({"PI_CODING_AGENT_DIR": str(agent_dir), "STARTUP_GUARD_STAGE": stage,
                "STARTUP_GUARD_MODULE": str(module), "STARTUP_GUARD_ROLE": str(repo / "skills/startup-role-dev/SKILL.md"),
                "STARTUP_GUARD_LOOP": str(repo / "skills/startup-loop/SKILL.md"),
                "STARTUP_GUARD_EVENTS": str(work / "events.jsonl"), "STARTUP_GUARD_REPORT": str(work / "report.json"),
                "STARTUP_GUARD_WRITE": str(cwd / "denied-write.txt"), "STARTUP_GUARD_BASH": str(cwd / "denied-bash.txt")})
    command = [omp, "--mode", "rpc", "--no-ui", "--cwd", str(cwd), "--config", str(config),
               "--no-extensions", "--no-skills", "--no-rules", "--no-lsp", "--no-pty", "--no-title",
               "--tools", "task,read,write,bash", "--extension", str(Path(__file__).with_name("native-v7-guards.ts")),
               "--model", "startup-v7-guard/offline", "--thinking", "off", "--auto-approve"]
    with (work / "stdout.jsonl").open("w") as stdout, (work / "stderr.txt").open("w") as stderr:
        process = subprocess.Popen(command, env=env, cwd=cwd, stdin=subprocess.PIPE, stdout=stdout, stderr=stderr, text=True)
        if process.stdin is None:
            raise RuntimeError("Native guard RPC stdin unavailable")
        process.stdin.write(json.dumps({"id": stage, "type": "prompt", "message": "/startup-v7-guards"}) + "\n")
        process.stdin.flush()
        deadline = time.monotonic() + 45
        while not (work / "report.json").exists() and process.poll() is None and time.monotonic() < deadline:
            time.sleep(0.05)
        process.stdin.close()
        try:
            exit_code = process.wait(timeout=5)
        except subprocess.TimeoutExpired:
            process.terminate()
            try:
                exit_code = process.wait(timeout=5)
            except subprocess.TimeoutExpired:
                process.kill()
                exit_code = process.wait()
    events = [json.loads(line) for line in (work / "events.jsonl").read_text().splitlines()] if (work / "events.jsonl").exists() else []
    return {"stage": stage, "command": command, "exitCode": exit_code,
            "report": json.loads((work / "report.json").read_text()) if (work / "report.json").exists() else None,
            "events": events, "actualProviderRequests": sum(event["kind"] == "provider" for event in events),
            "actualRootProviderRequests": sum(event["kind"] == "provider" and not event["helper"] for event in events),
            "writeExists": (cwd / "denied-write.txt").exists(), "bashExists": (cwd / "denied-bash.txt").exists(),
            "stdoutSha256": sha(work / "stdout.jsonl"), "stdoutTail": (work / "stdout.jsonl").read_text()[-12000:], "stderr": (work / "stderr.txt").read_text()}


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--evidence", required=True, type=Path)
    parser.add_argument("--omp-source", required=True, type=Path)
    args = parser.parse_args()
    repo = Path(__file__).resolve().parents[3]
    omp = shutil.which("omp")
    if omp is None:
        raise FileNotFoundError("Installed compiled OMP unavailable")
    workspace = Path(tempfile.mkdtemp(prefix="startup-v7-native-guards-"))
    (workspace / ".startup-proof-owner.json").write_text(json.dumps({"repo": str(repo), "kind": "v7-native-guards"}))
    source = repo / "extensions/startup/src/employee-client.ts"
    negative = workspace / "negative-source"
    shutil.copytree(source.parent, negative)
    (negative.parent / "node_modules").symlink_to(repo / "extensions/startup/node_modules", target_is_directory=True)
    original = source.read_text()
    start = original.index('  host.on("tool_call",', original.index("export function installEmployeeBridge"))
    end = original.index('  host.on("agent_end",', start)
    (negative / source.name).write_text(original[:start] + original[end:])
    version = subprocess.check_output([omp, "--version"], text=True).strip()
    evidence = {"status": "FAIL", "workspace": str(workspace), "executable": omp, "executableSha256": sha(Path(omp)),
                "installedVersion": version, "network": "none; deterministic in-process provider", "normalProfileUsed": False,
                "sourceHashes": {str(path): sha(path) for path in [source, Path(__file__), Path(__file__).with_name("native-v7-guards.ts"),
                    repo / "skills/startup-role-dev/SKILL.md", repo / "skills/startup-loop/SKILL.md", args.omp_source]},
                "negativeControl": {"change": "Removed only employee bridge tool_call handler in owned temporary copy", "sourceSha256": sha(negative / source.name)},
                "stages": [], "checks": {}}
    args.evidence.parent.mkdir(parents=True, exist_ok=True)
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    for stage in ["admitted", "denied", "disconnected", "synthetic-denied", "negative", "cache", "cost"]:
        result = run_stage(omp, repo, workspace, stage, negative / source.name if stage == "negative" else source)
        evidence["stages"].append(result)
        args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
        print(json.dumps({"stage": stage, "report": result["report"], "writeExists": result["writeExists"], "bashExists": result["bashExists"]}), flush=True)
    stages = {stage["stage"]: stage for stage in evidence["stages"]}
    admitted = stages["admitted"]
    providers = [event for event in admitted["events"] if event["kind"] == "provider" and not event["helper"]]
    cache_prompts = [event["cachePrompt"] for event in stages["cache"]["events"] if event["kind"] == "provider"]
    checks = {"compiled_omp_identified": re.fullmatch(r"omp/\S+", version) is not None,
              "all_native_stages_complete": all(stage["exitCode"] == 0 and stage["report"] and stage["report"]["status"] == "COMPLETE" for stage in stages.values()),
              "canonical_role_loop_in_actual_root_provider": bool(providers) and all(event["roleComplete"] and event["loopComplete"] for event in providers),
              "actual_native_helper_startup_tool_denied": any(event["kind"] == "provider" and event["helper"] and any(result["toolName"] == "startup_guard_probe" and result.get("isError") and "Native helper has no Startup employee authority" in str(result["content"]) for result in event["priorToolResults"]) for event in admitted["events"]) and not any(event["kind"] == "sentinel_executed" for event in admitted["events"]),
              "begin_turn_denial_blocks_native_write_and_bash": not stages["denied"]["writeExists"] and not stages["denied"]["bashExists"] and sum(event["kind"] == "mutation_denied" for event in stages["denied"]["events"]) == 2,
              "failed_connection_blocks_native_write_and_bash": not stages["disconnected"]["writeExists"] and not stages["disconnected"]["bashExists"] and sum(event["kind"] == "mutation_denied" for event in stages["disconnected"]["events"]) == 2,
              "denied_synthetic_context_blocks_provider": stages["synthetic-denied"]["report"] is not None and stages["synthetic-denied"]["report"].get("beginCount", 0) >= 2 and stages["synthetic-denied"]["actualProviderRequests"] == 0,
              "negative_control_detects_missing_tool_guard": stages["negative"]["writeExists"] and stages["negative"]["bashExists"],
              "cache_system_prompt_is_stable": len(cache_prompts) == 2 and cache_prompts[0]["systemPrompt"] == cache_prompts[1]["systemPrompt"] and "STARTUP_CHECKPOINT" not in str(cache_prompts[0]["systemPrompt"]),
              "cache_conversation_prefix_is_preserved": len(cache_prompts) == 2 and cache_prompts[0]["messages"][:-1] == cache_prompts[1]["messages"][:len(cache_prompts[0]["messages"]) - 1],
              "cache_live_state_is_trailing_user_data": len(cache_prompts) == 2 and all(prompt["messages"][-1]["role"] == "user" and f"STARTUP_CHECKPOINT={index}" in str(prompt["messages"][-1]["content"]) for index, prompt in enumerate(cache_prompts)),
              "provider_error_parks_100_inbox_changes_and_queued_retry": stages["cost"]["actualProviderRequests"] == 1 and any(event["kind"] == "cost_settled" and event["providerCount"] == 1 and event["pollsAfterFailure"] == 100 for event in stages["cost"]["events"])}
    evidence["checks"] = checks
    evidence["status"] = "PASS" if all(checks.values()) else "FAIL"
    args.evidence.write_text(json.dumps(evidence, indent=2) + "\n")
    print(json.dumps({"status": evidence["status"], "checks": checks, "evidence": str(args.evidence)}))
    return 0 if evidence["status"] == "PASS" else 1


if __name__ == "__main__":
    raise SystemExit(main())
