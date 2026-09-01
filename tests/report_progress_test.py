import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
SPEC = importlib.util.spec_from_file_location(
    "report_progress",
    ROOT / "skills/baidu-cloud-one-click-config/scripts/report_progress.py",
)
REPORT = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(REPORT)


class ReportProgressTest(unittest.TestCase):
    def state(self, path):
        value = {
            "apiBaseUrl": "https://auto-ux.example",
            "executionId": "Execution_1",
            "agentToken": "execution_token:" + "a" * 64,
            "agentId": "MacCodex",
            "sessionId": "Session_1",
        }
        REPORT.save(path, value)
        return value

    def test_codex_decision_is_saved_for_the_following_action_event(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = str(Path(directory) / "state.json")
            self.state(state_path)
            decided = {
                "action": "publish",
                "decision": "approved",
                "source": "codex",
                "decidedAt": "2026-08-06T04:00:00.000Z",
            }
            with patch.object(REPORT, "request_json", return_value=decided), patch.object(
                sys, "argv", ["report_progress.py", "decide", state_path, "publish", "approved"]
            ):
                REPORT.main()
            saved = json.loads(Path(state_path).read_text())
            self.assertEqual(saved["confirmations"]["publish"], decided)

    def test_action_event_reuses_the_recorded_approval_time(self):
        with tempfile.TemporaryDirectory() as directory:
            state_path = str(Path(directory) / "state.json")
            state = self.state(state_path)
            state["confirmations"] = {
                "publish": {
                    "action": "publish",
                    "decision": "approved",
                    "source": "website",
                    "decidedAt": "2026-08-06T04:00:00.000Z",
                }
            }
            REPORT.save(state_path, state)
            with patch.object(REPORT, "request_json", return_value={}) as request, patch.object(
                sys,
                "argv",
                [
                    "report_progress.py", "event", state_path,
                    "publish.verify", "succeeded", "publish_verify",
                    "--confirmed-action", "publish",
                ],
            ):
                REPORT.main()
            payload = request.call_args.args[3]
            self.assertEqual(payload["localConfirmation"]["confirmedAt"], "2026-08-06T04:00:00.000Z")

    def test_heartbeat_reclaims_only_after_a_lock_mismatch(self):
        state = {
            "apiBaseUrl": "https://auto-ux.example",
            "executionId": "Execution_1",
            "agentToken": "execution_token:" + "a" * 64,
            "agentId": "MacCodex",
            "sessionId": "Session_1",
        }
        calls = []

        def request(_state, method, path, payload=None):
            calls.append((method, path, payload))
            if path.endswith("/agent/heartbeat"):
                raise REPORT.ControlPlaneError(409, "EXECUTION_LOCK_MISMATCH")
            return {"pluginSessionCount": 1}

        with patch.object(REPORT, "request_json", side_effect=request):
            REPORT.renew_agent_lock(state)

        self.assertEqual(calls[0][1], "/api/executions/Execution_1/agent/heartbeat")
        self.assertEqual(calls[1][1], "/api/executions/Execution_1/agent/claim")

    def test_event_parser_rejects_non_contract_step_names(self):
        with patch.object(
            sys,
            "argv",
            [
                "report_progress.py", "event", "/tmp/not-read.json",
                "numbers.import", "succeeded", "numbers_confirm",
            ],
        ), self.assertRaises(SystemExit):
            REPORT.main()

    def test_call_event_keeps_only_safe_diagnostics(self):
        with tempfile.TemporaryDirectory() as directory:
            record_path = Path(directory) / "record.json"
            record_path.write_text(json.dumps({"items": [{
                "sessionId": "session-1",
                "mobile": "138****8000",
                "callerNum": "075****1348",
                "contextText": "private transcript",
                "isRobotHangup": True,
                "talkingTimeLen": 29,
                "talkingTurn": 2,
                "sipCode": "200",
                "sipInfo": "OK",
            }]}), encoding="utf-8")
            event = REPORT.call_record_event(
                self.state(Path(directory) / "state.json"),
                "failed",
                "robot_hangup_incomplete",
                str(record_path),
                1,
            )

        encoded = json.dumps(event)
        self.assertNotIn("138****8000", encoded)
        self.assertNotIn("private transcript", encoded)
        self.assertTrue(event["evidence"]["summary"]["isRobotHangup"])
        self.assertEqual(event["evidence"]["summary"]["talkingTimeLen"], 29)


if __name__ == "__main__":
    unittest.main()
