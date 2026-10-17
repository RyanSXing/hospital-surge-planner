"""No-network verification of temporary-account cleanup failure paths."""

import hashlib
import importlib.util
import json
from pathlib import Path
from unittest.mock import Mock

import httpx
import pytest

spec = importlib.util.spec_from_file_location(
    "viewer_load_harness", Path(__file__).resolve().parents[1] / "scripts/verify_viewer_load.py"
)
harness = importlib.util.module_from_spec(spec)
spec.loader.exec_module(harness)


def response(payload, status=200):
    return httpx.Response(status, json=payload, request=httpx.Request("GET", "https://example.invalid/api"))


def member(number, enabled=True, revision=1):
    return {
        "id": f"member-{number}",
        "username": f"verification-viewer-{number}",
        "enabled": enabled,
        "revision": revision,
    }


def test_checker_digest_and_serving_release_are_separate_from_retained_run():
    result = harness.verification_provenance(
        {"code_commit": "84d-final-serving"},
        {
            "manifest": {
                "code_commit": "2faf-retained-output",
                "model_version": "1.1.0",
                "generator_version": "1.1.0",
                "dataset_version_id": "demo-v1-1-0-planning_baseline-41021-365",
            }
        },
    )
    assert result["checker_sha256"] == hashlib.sha256(Path(harness.__file__).read_bytes()).hexdigest()
    assert result["serving_commit"] == "84d-final-serving"
    assert result["referenced_run_commit"] == "2faf-retained-output"
    assert result["referenced_run_model_version"] == "1.1.0"
    assert "does not assert fresh forecast provenance" in result["provenance_scope"]


def test_cleanup_attempts_every_account_persists_failure_and_raises(tmp_path):
    admin = Mock()
    attempts = [member(number) for number in range(10)]
    final = [member(number, enabled=number == 3) for number in range(10)]
    admin.get.side_effect = [response({"items": attempts}), response({"items": final})]
    admin.patch.side_effect = [response({}, status=503 if number == 3 else 200) for number in range(10)]
    broken_client, healthy_client = Mock(), Mock()
    broken_client.close.side_effect = RuntimeError("Do not leak private error text")
    path = tmp_path / "evidence" / "result.json"
    with pytest.raises(RuntimeError, match="cleanup incomplete"):
        harness.finish_verification(
            admin, [broken_client, healthy_client], attempts, {"status": "PASSED"}, path
        )
    saved = json.loads(path.read_text())
    assert admin.patch.call_count == 10
    assert [call.args[0].rsplit("/", 1)[1] for call in admin.patch.call_args_list] == [
        f"member-{number}" for number in range(10)
    ]
    healthy_client.close.assert_called_once()
    admin.close.assert_called_once()
    assert saved["status"] == "FAILED"
    assert saved["temporary_accounts_disabled"] == 9
    assert saved["cleanup_unresolved_usernames"] == ["verification-viewer-3"]
    assert saved["cleanup_errors"] == [
        {"phase": "disable", "error_type": "HTTPStatusError", "username": "verification-viewer-3"}
    ]
    assert saved["client_close_errors"] == ["RuntimeError"]
    assert "private error" not in path.read_text()


def test_ambiguous_create_replays_same_key_then_reconciles_unique_name():
    admin = Mock()
    admin.post.side_effect = [httpx.ReadTimeout("lost response"), httpx.ReadTimeout("lost again")]
    admin.get.return_value = response({"items": [member(1), member(99)]})
    attempts = []
    result = harness.create_temporary_member(admin, attempts, member(1)["username"], "secret-password", 0)
    assert result == member(1)
    assert attempts == [member(1)]
    calls = admin.post.call_args_list
    assert calls[0].kwargs["headers"] == calls[1].kwargs["headers"]
    assert calls[0].kwargs["json"] == calls[1].kwargs["json"]
    assert "password" not in attempts[0]


def test_cleanup_discovers_creation_when_create_and_reconciliation_responses_failed(tmp_path):
    admin = Mock()
    admin.post.side_effect = httpx.ReadTimeout("lost")
    admin.get.side_effect = [
        httpx.ConnectError("unavailable"),
        response({"items": [member(1, revision=4), member(99)]}),
        response({"items": [member(1, enabled=False, revision=5), member(99)]}),
    ]
    admin.patch.return_value = response({})
    attempts = []
    with pytest.raises(httpx.ConnectError):
        harness.create_temporary_member(admin, attempts, member(1)["username"], "secret-password", 0)
    report = {"status": "FAILED", "failure_type": "ConnectError"}
    path = tmp_path / "proof.json"
    harness.finish_verification(admin, [], attempts, report, path)
    admin.patch.assert_called_once_with(
        harness.MEMBERS_PATH + "/member-1", json={"enabled": False}, headers={"If-Match": "4"}
    )
    saved = json.loads(path.read_text())
    assert saved["status"] == "FAILED"
    assert saved["cleanup_complete"]
    assert saved["temporary_accounts_disabled"] == 1
    assert saved["cleanup_errors"] == []


def test_lost_disable_response_is_confirmed_by_final_catalog(tmp_path):
    admin = Mock()
    admin.get.side_effect = [
        response({"items": [member(1)]}),
        response({"items": [member(1, enabled=False)]}),
    ]
    admin.patch.side_effect = httpx.ReadTimeout("lost after commit")
    path = tmp_path / "proof.json"
    harness.finish_verification(admin, [], [member(1)], {"status": "PASSED"}, path)
    saved = json.loads(path.read_text())
    assert saved["status"] == "PASSED"
    assert saved["cleanup_complete"]
    assert saved["temporary_accounts_disabled"] == 1
    assert saved["cleanup_errors"][0]["error_type"] == "ReadTimeout"


def test_catalog_failure_still_attempts_known_accounts_and_fails_unverified_cleanup(tmp_path):
    admin = Mock()
    admin.get.side_effect = httpx.ConnectError("catalog unavailable")
    admin.patch.return_value = response({})
    path = tmp_path / "proof.json"
    with pytest.raises(RuntimeError, match="cleanup incomplete"):
        harness.finish_verification(admin, [], [member(1), member(2)], {"status": "PASSED"}, path)
    assert admin.patch.call_count == 2
    saved = json.loads(path.read_text())
    assert saved["status"] == "FAILED"
    assert saved["temporary_accounts_disabled"] == 0
    assert saved["cleanup_unresolved_usernames"] == [member(1)["username"], member(2)["username"]]
    assert [error["phase"] for error in saved["cleanup_errors"]] == [
        "reconcile_before_cleanup",
        "verify_cleanup",
    ]


def test_rejected_create_without_an_account_does_not_fail_cleanup():
    admin = Mock()
    admin.get.return_value = response({"items": [member(99)]})
    result = harness.cleanup_temporary_members(admin, [{"username": member(1)["username"]}])
    admin.patch.assert_not_called()
    assert result["cleanup_complete"]
    assert result["temporary_accounts_attempted"] == 1
    assert result["temporary_accounts_disabled"] == 0
