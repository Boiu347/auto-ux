#!/usr/bin/env python3
"""CLI for deterministic quick-scene robot API operations."""

from __future__ import annotations

import argparse

from baidu_api_client import (
    BaiduApiError,
    client_from_local_credentials,
    load_json_file,
    print_result,
)


MUTATIONS = {
    "create": "/api/v1/robot/manage/create",
    "edit": "/api/v1/robot/manage/edit",
    "configure-script": "/api/v1/robot/config/script",
    "configure-setting": "/api/v1/robot/config/setting",
    "configure-voice": "/api/v1/robot/config/voice",
    "publish": "/api/v1/robot/manage/publish",
}
QUERIES = {
    "query-script": "/api/v1/robot/query/listscript",
    "query-setting": "/api/v1/robot/query/listsetting",
}


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


def assert_target(client, payload: dict, lock_path: str) -> dict:
    lock = load_json_file(lock_path)
    require_keys(lock, "executionId", "platformId", "robotId", "robotName")
    require_keys(payload, "robotId")
    if payload["robotId"] != lock["robotId"]:
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


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--keychain-account", default="default")
    commands = parser.add_subparsers(dest="command", required=True)
    commands.add_parser("preflight")
    commands.add_parser("list-voices")
    query = commands.add_parser("query")
    query.add_argument("--robot-id")
    query.add_argument("--robot-name")
    for name in QUERIES:
        command = commands.add_parser(name)
        command.add_argument("--robot-id", required=True)
    for name in MUTATIONS:
        command = commands.add_parser(name)
        command.add_argument("--payload", required=True)
        if name != "create":
            command.add_argument("--target-lock", required=True)
        if name == "publish":
            command.add_argument("--confirmation-ref", required=True)
    args = parser.parse_args()

    try:
        client = client_from_local_credentials(args.keychain_account)
        if args.command == "preflight":
            robots = client.request(
                "GET", "/api/v1/robot/query/list", params={"pn": 1, "ps": 1}, retry_safe=True
            )
            voices = client.request("GET", "/api/v1/robot/ttsasr", retry_safe=True)
            print_result(
                {
                    "ok": True,
                    "robotQueryAvailable": robots.get("code") == 200,
                    "voiceQueryAvailable": voices.get("code") == 200,
                    "requestIds": [robots.get("requestId"), voices.get("requestId")],
                }
            )
        elif args.command == "list-voices":
            print_result(client.request("GET", "/api/v1/robot/ttsasr", retry_safe=True))
        elif args.command == "query":
            params = {"pn": 1, "ps": 48}
            if args.robot_id:
                params["robotId"] = args.robot_id
            if args.robot_name:
                params["robotName"] = args.robot_name
            if len(params) == 2:
                raise BaiduApiError("INVALID_INPUT", "robot id or name required")
            print_result(client.request("GET", "/api/v1/robot/query/list", params=params, retry_safe=True))
        elif args.command in QUERIES:
            print_result(
                client.request(
                    "GET", QUERIES[args.command], params={"robotId": args.robot_id}, retry_safe=True
                )
            )
        else:
            payload = load_json_file(args.payload)
            if args.command == "create":
                require_keys(payload, "robotName")
            else:
                assert_target(client, payload, args.target_lock)
            response = client.request("POST", MUTATIONS[args.command], payload=payload)
            if args.command == "create":
                data = response.get("data") or {}
                print_result(
                    {
                        "code": response.get("code"),
                        "requestId": response.get("requestId"),
                        "target": {
                            "platformId": data.get("id"),
                            "robotId": data.get("robotId"),
                            "robotName": data.get("robotName"),
                            "publishState": data.get("publishState"),
                        },
                    }
                )
            else:
                print_result(response)
        return 0
    except BaiduApiError as error:
        print_result({"ok": False, "errorCode": error.code})
        return 6 if error.code == "BAIDU_MUTATION_OUTCOME_UNKNOWN" else 2


if __name__ == "__main__":
    raise SystemExit(main())
