import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "baidu-cloud-one-click-config" / "scripts"


def run_script(name: str, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(SCRIPTS / name), *args],
        cwd=ROOT,
        text=True,
        capture_output=True,
        check=False,
    )


class PhoneBatchTests(unittest.TestCase):
    def test_outputs_only_masked_numbers_and_counts(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "numbers.txt"
            source.write_text("13800138000\n13800138000\nnot-a-phone\n13900139000\n", encoding="utf-8")

            result = run_script("phone_batch.py", str(source))

        self.assertEqual(result.returncode, 0, result.stderr)
        self.assertNotIn("13800138000", result.stdout)
        self.assertNotIn("13900139000", result.stdout)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["total"], 4)
        self.assertEqual(payload["valid"], 2)
        self.assertEqual(payload["duplicates"], 1)
        self.assertEqual(payload["invalid"], [{"line": 3, "reason": "invalid_phone"}])
        self.assertEqual(payload["maskedNumbers"], ["138****8000", "139****9000"])


class ConfigDraftTests(unittest.TestCase):
    def test_preserves_provenance_and_reports_conflicts_and_missing_fields(self) -> None:
        sources = [
            {"sourceId": "doc-1", "locator": "开场白", "fields": {"robotName": "回访机器人", "openingLine": "您好"}},
            {"sourceId": "minutes-1", "locator": "第12分钟", "fields": {"openingLine": "您好，请问方便吗"}},
        ]
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "sources.json"
            source.write_text(json.dumps(sources, ensure_ascii=False), encoding="utf-8")
            result = run_script("build_config_draft.py", str(source))

        self.assertEqual(result.returncode, 2)
        payload = json.loads(result.stdout)
        self.assertEqual(payload["status"], "needs_user_resolution")
        self.assertIn("openingLine", payload["conflicts"])
        self.assertIn("voice", payload["missingFields"])
        self.assertEqual(payload["fields"]["robotName"]["sources"][0]["sourceId"], "doc-1")


class ExecutionStateTests(unittest.TestCase):
    def test_requires_separate_single_use_confirmation_for_each_risky_action(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = Path(temp_dir) / "state.json"
            self.assertEqual(run_script("execution_state.py", "init", str(state), "EX-1").returncode, 0)

            blocked = run_script("execution_state.py", "authorize", str(state), "publish")
            self.assertEqual(blocked.returncode, 3)
            self.assertEqual(json.loads(blocked.stdout)["reason"], "confirmation_required")

            issued = run_script("execution_state.py", "confirm", str(state), "publish")
            self.assertEqual(issued.returncode, 0, issued.stderr)
            allowed = run_script("execution_state.py", "authorize", str(state), "publish")
            self.assertEqual(allowed.returncode, 0, allowed.stderr)
            reused = run_script("execution_state.py", "authorize", str(state), "publish")
            self.assertEqual(reused.returncode, 3)
            self.assertEqual(json.loads(reused.stdout)["reason"], "confirmation_consumed")

            dial = run_script("execution_state.py", "authorize", str(state), "start_dial")
            self.assertEqual(dial.returncode, 3)
            self.assertEqual(json.loads(dial.stdout)["reason"], "confirmation_required")

    def test_blocks_duplicate_actions_and_third_attempt(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            state = Path(temp_dir) / "state.json"
            run_script("execution_state.py", "init", str(state), "EX-2")
            first = run_script("execution_state.py", "record", str(state), "field.write", "sha256:abc", "succeeded")
            duplicate = run_script("execution_state.py", "record", str(state), "field.write", "sha256:abc", "running")
            retry_one = run_script("execution_state.py", "attempt", str(state), "field.verify")
            retry_two = run_script("execution_state.py", "attempt", str(state), "field.verify")
            retry_three = run_script("execution_state.py", "attempt", str(state), "field.verify")

        self.assertEqual(first.returncode, 0, first.stderr)
        self.assertEqual(duplicate.returncode, 4)
        self.assertEqual(json.loads(duplicate.stdout)["reason"], "duplicate_action")
        self.assertEqual(json.loads(retry_one.stdout)["attempt"], 1)
        self.assertEqual(json.loads(retry_two.stdout)["attempt"], 2)
        self.assertEqual(retry_three.returncode, 4)
        self.assertEqual(json.loads(retry_three.stdout)["reason"], "retry_budget_exhausted")


class EvidenceTests(unittest.TestCase):
    def test_field_write_requires_target_identity_and_readback_hash(self) -> None:
        evidence = {
            "step": "field.write",
            "target": {"agentId": "A-1", "robotId": "R-1", "robotName": "回访机器人"},
            "inputHash": "sha256:input",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "evidence.json"
            source.write_text(json.dumps(evidence, ensure_ascii=False), encoding="utf-8")
            result = run_script("validate_evidence.py", str(source))

        self.assertEqual(result.returncode, 5)
        self.assertEqual(json.loads(result.stdout)["missing"], ["readbackHash"])


if __name__ == "__main__":
    unittest.main()
