import gzip
import importlib.util
import io
import json
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch


DRIVER_PATH = Path(__file__).with_name("run-native-probe.py")
SPEC = importlib.util.spec_from_file_location("native_probe_driver", DRIVER_PATH)
if SPEC is None or SPEC.loader is None:
    raise RuntimeError(f"Cannot load native probe driver: {DRIVER_PATH}")
DRIVER = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(DRIVER)


class NativeProbeDriverRegression(unittest.TestCase):
    def test_native_preflight_error_is_a_failed_delegation(self) -> None:
        failures = [
            {"content": [{"type": "text", "text": "Task execution failed: Unknown agent fixture"}], "details": {"projectAgentsDir": None, "results": [], "totalDurationMs": 0}},
            {"content": [{"type": "text", "text": "Missing tasks"}], "isError": True, "details": {}},
            {"content": [{"type": "text", "text": "Unknown agent"}], "isError": True, "details": {"results": []}},
        ]
        for failure in failures:
            with self.subTest(failure=failure):
                events = [{"kind": "task_wrapper"}, {"kind": "task_delegate_result", "result": failure}]
                checks = DRIVER.acceptance_checks(events, {"status": "FAIL", "error": "Native preflight failed"}, 0, "role", "loop", False, True, [])
                self.assertFalse(checks["ordinary_batch_delegation"])
                self.assertFalse(checks["native_completion"])

    def run_failed_process(self, workspace: Path, evidence: Path, report_text: str | None) -> None:
        events = [
            {"kind": "task_wrapper"},
            {"kind": "task_delegate_result", "result": {"content": [{"type": "text", "text": "Unknown agent fixture"}], "details": {"projectAgentsDir": None, "results": [], "totalDurationMs": 0}}},
        ]
        def spawn(_command: list[str], **kwargs: object):
            env = kwargs["env"]
            Path(env["STARTUP_PROBE_EVENTS"]).write_text("\n".join(json.dumps(event) for event in events) + "\n")
            if report_text is not None:
                Path(env["STARTUP_PROBE_REPORT"]).write_text(report_text)
            process = unittest.mock.Mock()
            process.stdin = io.StringIO()
            process.poll.return_value = 0
            process.wait.return_value = 0
            return process
        with patch.object(sys, "argv", [str(DRIVER_PATH), "--workspace", str(workspace), "--evidence", str(evidence)]), patch.object(DRIVER.shutil, "which", return_value="/isolated/fake-omp"), patch.object(DRIVER.subprocess, "check_output", return_value="omp/18.8.9\n"), patch.object(DRIVER.subprocess, "Popen", side_effect=spawn):
            self.assertEqual(DRIVER.main(), 1)

    def test_failures_replace_stale_pass_evidence(self) -> None:
        reports = [
            '{"status":"FAIL","error":"Native preflight: Unknown agent fixture"}',
            None,
            "{broken-json",
            "{}",
            "[]",
            '{"status":[]}',
            '{"status":"INVALID"}',
            '{"status":"FAIL"}',
            '{"status":"COMPLETE"}',
        ]
        with tempfile.TemporaryDirectory(prefix="driver-regression-") as directory:
            for index, report in enumerate(reports):
                with self.subTest(report=report):
                    evidence = Path(directory) / f"evidence-{index}.json.gz"
                    evidence.write_bytes(gzip.compress(b'{"gateVersion":1,"status":"PASS","stale":true}'))
                    self.run_failed_process(Path(directory) / f"run-{index}", evidence, report)
                    record = json.loads(gzip.decompress(evidence.read_bytes()))
                    self.assertEqual(record["gateVersion"], 1)
                    self.assertEqual(record["status"], "FAIL")
                    self.assertNotIn("stale", record)
                    self.assertIn("Unknown agent fixture", json.dumps(record))
                    if report is None or report not in {reports[0]}:
                        self.assertIn("failure", record)

    def test_unexpected_validation_error_is_preserved_and_raised(self) -> None:
        with tempfile.TemporaryDirectory(prefix="driver-regression-") as directory:
            for index, error_type in enumerate([RuntimeError, KeyError, TypeError]):
                with self.subTest(error_type=error_type):
                    evidence = Path(directory) / f"evidence-{index}.json.gz"
                    evidence.write_bytes(gzip.compress(b'{"gateVersion":1,"status":"PASS"}'))
                    with patch.object(DRIVER, "acceptance_checks", side_effect=error_type("Unexpected acceptance failure")):
                        with self.assertRaisesRegex(error_type, "Unexpected acceptance failure"):
                            self.run_failed_process(Path(directory) / f"run-{index}", evidence, '{"status":"FAIL","error":"Native preflight failed"}')
                    record = json.loads(gzip.decompress(evidence.read_bytes()))
                    self.assertEqual(record["status"], "FAIL")
                    self.assertEqual(record["failure"]["type"], error_type.__name__)
                    self.assertIn("Unexpected acceptance failure", record["failure"]["message"])


if __name__ == "__main__":
    unittest.main()
