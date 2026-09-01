import json
import subprocess
import sys
import tempfile
import unittest
import urllib.error
from io import BytesIO
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
SCRIPTS = ROOT / "skills" / "baidu-cloud-one-click-config" / "scripts"
sys.path.insert(0, str(SCRIPTS))

from baidu_api_client import BaiduApiClient, BaiduApiError, sanitize
from baidu_outbound_api import assert_robot_lock, assert_task_lock, call_summary
from baidu_robot_api import assert_target


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
        self.assertEqual(
            json.loads(result.stdout)["missing"], ["requestId", "readbackHash"]
        )

    def test_api_field_write_accepts_platform_identity_and_request_id(self) -> None:
        evidence = {
            "step": "field.write",
            "target": {
                "platformId": 123,
                "robotId": "R-1",
                "robotName": "回访机器人",
            },
            "requestId": "request-1",
            "inputHash": "sha256:input",
            "readbackHash": "sha256:readback",
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            source = Path(temp_dir) / "evidence.json"
            source.write_text(json.dumps(evidence, ensure_ascii=False), encoding="utf-8")
            result = run_script("validate_evidence.py", str(source))

        self.assertEqual(result.returncode, 0, result.stdout)
        self.assertTrue(json.loads(result.stdout)["ok"])


class FakeResponse:
    def __init__(self, payload: dict) -> None:
        self.body = BytesIO(json.dumps(payload).encode("utf-8"))

    def __enter__(self):
        return self

    def __exit__(self, *_args):
        return False

    def read(self) -> bytes:
        return self.body.read()


class BaiduApiClientTests(unittest.TestCase):
    def token_response(self) -> FakeResponse:
        return FakeResponse(
            {
                "code": 200,
                "msg": "OK",
                "data": {"accessToken": "token-value", "expiresTime": 43200},
            }
        )

    def test_uses_token_cache_without_persisting_ak_or_sk(self) -> None:
        calls = []

        def opener(request, timeout):
            calls.append((request, timeout))
            return self.token_response()

        with tempfile.TemporaryDirectory() as temp_dir:
            cache = Path(temp_dir) / "token.json"
            client = BaiduApiClient(
                "access-value", "secret-value", cache, opener=opener, now=lambda: 1000
            )
            self.assertEqual(client.get_token(), "token-value")
            self.assertEqual(client.get_token(), "token-value")
            persisted = cache.read_text(encoding="utf-8")
            cache_mode = cache.stat().st_mode & 0o777

        self.assertEqual(len(calls), 1)
        self.assertNotIn("access-value", persisted)
        self.assertNotIn("secret-value", persisted)
        self.assertEqual(cache_mode, 0o600)

    def test_does_not_retry_mutation_after_unknown_network_outcome(self) -> None:
        calls = []

        def opener(request, timeout):
            calls.append(request.full_url)
            if request.full_url.endswith("/api/v2/getToken"):
                return self.token_response()
            raise urllib.error.URLError("timeout")

        client = BaiduApiClient("ak", "sk", opener=opener)
        with self.assertRaises(BaiduApiError) as caught:
            client.request(
                "POST", "/api/v1/robot/manage/create", payload={"robotName": "test"}
            )

        self.assertEqual(caught.exception.code, "BAIDU_MUTATION_OUTCOME_UNKNOWN")
        self.assertEqual(calls.count("https://aiob-open.baidu.com/api/v1/robot/manage/create"), 1)

    def test_retries_only_explicitly_safe_read_operation_once(self) -> None:
        attempts = 0

        def opener(request, timeout):
            nonlocal attempts
            if request.full_url.endswith("/api/v2/getToken"):
                return self.token_response()
            attempts += 1
            if attempts == 1:
                raise urllib.error.URLError("temporary")
            return FakeResponse({"code": 200, "msg": "OK", "data": {"total": 0}})

        client = BaiduApiClient("ak", "sk", opener=opener)
        response = client.request(
            "GET",
            "/api/v1/robot/query/list",
            params={"pn": 1, "ps": 1},
            retry_safe=True,
        )

        self.assertEqual(response["data"]["total"], 0)
        self.assertEqual(attempts, 2)

    def test_rejects_unlisted_hosts_and_redacts_sensitive_output(self) -> None:
        client = BaiduApiClient("ak", "sk", opener=lambda *_args, **_kwargs: None)
        with self.assertRaises(BaiduApiError) as caught:
            client.request("GET", "https://example.com/api/v1/test")

        cleaned = sanitize(
            {
                "accessToken": "secret-token",
                "mobile": "13800138000",
                "record": [{"contextText": "private transcript"}],
                "message": "call 07567171348",
            }
        )
        self.assertEqual(caught.exception.code, "BAIDU_ENDPOINT_NOT_ALLOWED")
        self.assertEqual(cleaned["accessToken"], "[REDACTED]")
        self.assertEqual(cleaned["mobile"], "138****8000")
        self.assertEqual(cleaned["record"], "[REDACTED]")
        self.assertNotIn("07567171348", cleaned["message"])


class FakeBaiduClient:
    def __init__(self, response: dict) -> None:
        self.response = response
        self.calls = []

    def request(self, method, path, **kwargs):
        self.calls.append((method, path, kwargs))
        return self.response


class BaiduApiGuardTests(unittest.TestCase):
    def write_json(self, directory: str, name: str, payload: dict) -> Path:
        path = Path(directory) / name
        path.write_text(json.dumps(payload, ensure_ascii=False), encoding="utf-8")
        return path

    def test_robot_target_lock_rejects_platform_identity_mismatch(self) -> None:
        client = FakeBaiduClient(
            {
                "code": 200,
                "data": {
                    "list": [
                        {"id": 99, "robotId": "R-1", "robotName": "other-name"}
                    ]
                },
            }
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            lock = self.write_json(
                temp_dir,
                "robot-lock.json",
                {
                    "executionId": "EX-1",
                    "platformId": 99,
                    "robotId": "R-1",
                    "robotName": "expected-name",
                },
            )
            with self.assertRaises(BaiduApiError) as caught:
                assert_target(client, {"robotId": "R-1"}, str(lock))

        self.assertEqual(caught.exception.code, "TARGET_MISMATCH")

    def test_create_task_robot_lock_queries_and_rejects_mismatch(self) -> None:
        client = FakeBaiduClient(
            {
                "code": 200,
                "data": {"list": [{"id": 10, "robotId": "R-2", "robotName": "locked"}]},
            }
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            lock = self.write_json(
                temp_dir,
                "robot-lock.json",
                {
                    "executionId": "EX-2",
                    "platformId": 10,
                    "robotId": "R-1",
                    "robotName": "locked",
                    "publishedPlatformId": 11,
                    "publishedRobotId": "RP-1",
                    "publishedVersion": 2,
                },
            )
            with self.assertRaises(BaiduApiError) as caught:
                assert_robot_lock(client, {"robotId": "RP-1"}, str(lock))

        self.assertEqual(caught.exception.code, "TARGET_MISMATCH")
        self.assertEqual(client.calls[0][1], "/api/v1/robot/query/list")

    def test_task_lock_rejects_current_task_identity_mismatch(self) -> None:
        client = FakeBaiduClient(
            {
                "code": 200,
                "data": {"taskId": 7, "taskName": "renamed", "robotId": "R-1"},
            }
        )
        with tempfile.TemporaryDirectory() as temp_dir:
            lock = self.write_json(
                temp_dir,
                "task-lock.json",
                {
                    "executionId": "EX-3",
                    "taskId": 7,
                    "taskName": "expected",
                    "robotId": "R-1",
                },
            )
            with self.assertRaises(BaiduApiError) as caught:
                assert_task_lock(client, {"taskId": 7}, str(lock))

        self.assertEqual(caught.exception.code, "TARGET_MISMATCH")

    def test_start_dial_confirmation_is_checked_before_credentials(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            payload = self.write_json(
                temp_dir, "status.json", {"taskId": 7, "taskStatus": 2}
            )
            lock = self.write_json(
                temp_dir,
                "task-lock.json",
                {
                    "executionId": "EX-4",
                    "taskId": 7,
                    "taskName": "task",
                    "robotId": "R-1",
                },
            )
            result = run_script(
                "baidu_outbound_api.py",
                "update-status",
                "--payload",
                str(payload),
                "--task-lock",
                str(lock),
            )

        self.assertEqual(result.returncode, 2)
        self.assertEqual(json.loads(result.stdout)["errorCode"], "CONFIRMATION_REQUIRED")

    def test_call_summary_masks_numbers_and_supports_task_filtering(self) -> None:
        summary = call_summary(
            {
                "code": 200,
                "data": {
                    "requestId": "request-1",
                    "items": [
                        {
                            "taskId": 7,
                            "mobile": "13800138000",
                            "callerNum": "07567171348",
                            "contextText": "must not escape",
                            "isRobotHangup": True,
                            "talkingTimeLen": 29,
                            "talkingTurn": 2,
                            "sipCode": "200",
                            "sipInfo": "OK",
                        },
                        {"taskId": 8, "mobile": "13900139000"},
                    ],
                },
            }
        )
        summary["items"] = [
            item for item in summary["items"] if str(item.get("taskId")) == "7"
        ]

        encoded = json.dumps(summary, ensure_ascii=False)
        self.assertEqual(len(summary["items"]), 1)
        self.assertEqual(summary["items"][0]["mobile"], "138****8000")
        self.assertEqual(summary["items"][0]["callerNum"], "075****1348")
        self.assertTrue(summary["items"][0]["isRobotHangup"])
        self.assertEqual(summary["items"][0]["talkingTimeLen"], 29)
        self.assertEqual(summary["items"][0]["talkingTurn"], 2)
        self.assertEqual(summary["items"][0]["sipCode"], "200")
        self.assertNotIn("13800138000", encoded)
        self.assertNotIn("must not escape", encoded)


if __name__ == "__main__":
    unittest.main()
