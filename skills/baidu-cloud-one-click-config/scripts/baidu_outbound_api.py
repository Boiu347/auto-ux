#!/usr/bin/env python3
"""CLI for deterministic Baidu Keyue task, import, and call-result operations."""

from __future__ import annotations

import argparse

from baidu_api_client import (
    BaiduApiError,
    client_from_local_credentials,
    load_json_file,
    print_result,
    sanitize,
)


def require_keys(payload: dict, *keys: str) -> None:
    missing = [key for key in keys if payload.get(key) in (None, "")]
    if missing:
        raise BaiduApiError("INVALID_INPUT", "missing " + ",".join(missing))


def iter_dicts(value):
    if isinstance(value, dict):
        yield value
        for item in value.values():
            yield from iter_dicts(item)
    elif isinstance(value, list):
        for item in value:
            yield from iter_dicts(item)


def assert_robot_lock(client, payload: dict, lock_path: str) -> dict:
    lock = load_json_file(lock_path)
    require_keys(lock, "executionId", "platformId", "robotId", "robotName")
    if payload.get("robotId") != lock["robotId"]:
        raise BaiduApiError("TARGET_MISMATCH")
    response = client.request(
        "GET",
        "/api/v1/robot/query/list",
        params={"pn": 1, "ps": 10, "robotId": lock["robotId"]},
        retry_safe=True,
    )
    matches = [
        item
        for item in iter_dicts(response.get("data"))
        if item.get("robotId") == lock["robotId"]
    ]
    if len(matches) != 1:
        raise BaiduApiError("TARGET_MISMATCH")
    target = matches[0]
    if str(target.get("id")) != str(lock["platformId"]) or target.get("robotName") != lock["robotName"]:
        raise BaiduApiError("TARGET_MISMATCH")
    return lock


def assert_task_lock(client, payload: dict, lock_path: str) -> dict:
    lock = load_json_file(lock_path)
    require_keys(lock, "executionId", "taskId", "taskName", "robotId")
    if str(payload.get("taskId")) != str(lock["taskId"]):
        raise BaiduApiError("TARGET_MISMATCH")
    current = client.request(
        "POST",
        "/api/v3/console/apitask/gettask",
        payload={"taskId": lock["taskId"]},
        retry_safe=True,
    ).get("data") or {}
    if (
        str(current.get("taskId")) != str(lock["taskId"])
        or current.get("taskName") != lock["taskName"]
        or current.get("robotId") != lock["robotId"]
    ):
        raise BaiduApiError("TARGET_MISMATCH")
    return lock


def call_summary(response: dict) -> dict:
    data = response.get("data") or {}
    items = []
    for item in data.get("items") or []:
        items.append(
            sanitize(
                {
                    key: item.get(key)
                    for key in (
                        "sessionId",
                        "memberId",
                        "taskId",
                        "taskName",
                        "robotId",
                        "robotName",
                        "mobile",
                        "callerNum",
                        "endType",
                        "endTypeReason",
                        "isAnswer",
                        "completeType",
                        "startTime",
                        "talkingStartTime",
                        "endTime",
                    )
                }
            )
        )
    return {
        "code": response.get("code"),
        "requestId": data.get("requestId") or response.get("requestId"),
        "hasMore": data.get("hasMore", False),
        "nextCursor": data.get("nextCursor"),
        "total": data.get("total"),
        "items": items,
    }


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keychain-account", default="default")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("list-dids")
    create_task = commands.add_parser("create-task")
    create_task.add_argument("--payload", required=True)
    create_task.add_argument("--target-lock", required=True)
    get_task = commands.add_parser("get-task")
    get_task.add_argument("--payload", required=True)
    list_details = commands.add_parser("list-details")
    list_details.add_argument("--payload", required=True)
    list_details.add_argument("--task-id", required=True)
    import_members = commands.add_parser("import-members")
    import_members.add_argument("--payload", required=True)
    import_members.add_argument("--task-lock", required=True)
    import_members.add_argument("--confirmation-ref", required=True)
    update = commands.add_parser("update-status")
    update.add_argument("--payload", required=True)
    update.add_argument("--task-lock", required=True)
    update.add_argument("--confirmation-ref")
    args = parser.parse_args()

    try:
        if args.command == "list-dids":
            client = client_from_local_credentials(args.keychain_account)
            print_result(client.request("GET", "/api/v1/did/list", retry_safe=True))
            return 0

        payload = load_json_file(args.payload)
        if args.command == "update-status" and payload.get("taskStatus") == 2 and not args.confirmation_ref:
            raise BaiduApiError("CONFIRMATION_REQUIRED", "start_dial")
        client = client_from_local_credentials(args.keychain_account)
        if args.command == "create-task":
            require_keys(payload, "taskName", "robotId", "dialStartDate", "isOpenEmptyNum", "isOpenPhoneDown")
            assert_robot_lock(client, payload, args.target_lock)
            response = client.request("POST", "/api/v4/console/apitask/create", payload=payload)
            task_id = (response.get("data") or {}).get("taskId")
            print_result(
                {
                    "code": response.get("code"),
                    "requestId": response.get("requestId"),
                    "target": {
                        "taskId": task_id,
                        "taskName": payload["taskName"],
                        "robotId": payload["robotId"],
                    },
                }
            )
        elif args.command == "get-task":
            require_keys(payload, "taskId")
            print_result(
                client.request(
                    "POST", "/api/v3/console/apitask/gettask", payload=payload, retry_safe=True
                )
            )
        elif args.command == "import-members":
            require_keys(payload, "taskId", "secretType", "customerInfoList")
            assert_task_lock(client, payload, args.task_lock)
            response = client.request("POST", "/api/v3/console/apitask/import", payload=payload)
            data = response.get("data") or {}
            print_result(
                {
                    "code": response.get("code"),
                    "requestId": response.get("requestId"),
                    "successNum": data.get("successNum"),
                    "failedNum": data.get("failedNum"),
                    "members": [
                        {
                            "status": item.get("status"),
                            "reason": item.get("reason"),
                            "taskMemberId": item.get("taskMemberId"),
                        }
                        for item in data.get("resList") or []
                    ],
                }
            )
        elif args.command == "update-status":
            require_keys(payload, "taskId", "taskStatus")
            assert_task_lock(client, payload, args.task_lock)
            print_result(
                client.request(
                    "POST", "/api/v3/console/apitask/task/status/update", payload=payload
                )
            )
        elif args.command == "list-details":
            require_keys(payload, "searchStartTime", "searchEndTime")
            summary = call_summary(
                client.request(
                    "POST",
                    "/api/v3/console/apitask/member/list",
                    payload=payload,
                    retry_safe=True,
                )
            )
            summary["items"] = [
                item for item in summary["items"] if str(item.get("taskId")) == str(args.task_id)
            ]
            print_result(summary)
        return 0
    except BaiduApiError as error:
        print_result({"ok": False, "errorCode": error.code})
        return 6 if error.code == "BAIDU_MUTATION_OUTCOME_UNKNOWN" else 2


if __name__ == "__main__":
    raise SystemExit(main())
