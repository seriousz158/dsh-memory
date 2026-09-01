#!/usr/bin/env python3
"""Regression coverage for host-side sync failure diagnostics."""

import json
import os
import pathlib
import subprocess
import tempfile
import importlib.util


ROOT = pathlib.Path(__file__).resolve().parents[1]
HELPER = ROOT / "packages/dsh-memory/lib/sync-apply.py"
SPEC = importlib.util.spec_from_file_location("sync_apply", HELPER)
SYNC_APPLY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(SYNC_APPLY)


def run_helper(*args):
    result = subprocess.run(
        ["/usr/bin/python3", str(HELPER), *map(str, args)],
        text=True,
        capture_output=True,
        check=False,
    )
    assert result.stdout, result
    return result.returncode, json.loads(result.stdout)


def init_root(root: pathlib.Path, duplicate=False):
    for directory in ("handbook", "rollouts", "archive"):
        (root / directory).mkdir(parents=True)
    (root / "summary.md").write_text("summary\n", encoding="utf-8")
    (root / "README.md").write_text("rules\n", encoding="utf-8")
    record = "---\nschema_version: 1\nid: same-record\ntype: fact\n---\nbody\n"
    (root / "handbook/a.md").write_text(record, encoding="utf-8")
    if duplicate:
        (root / "rollouts/b.md").write_text(record, encoding="utf-8")
    subprocess.run(["git", "-C", str(root), "init", "--quiet"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", "Test"], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", "test@example.invalid"], check=True)
    subprocess.run(["git", "-C", str(root), "add", "."], check=True)
    subprocess.run(["git", "-C", str(root), "commit", "--quiet", "-m", "fixture"], check=True)


def test_baseline_duplicate():
    with tempfile.TemporaryDirectory(prefix="dsh-memory-duplicate-") as directory:
        root = pathlib.Path(directory) / "memory"
        root.mkdir()
        init_root(root, duplicate=True)
        staging = pathlib.Path(directory) / "staging"
        manifest = pathlib.Path(directory) / "manifest.json"
        code, result = run_helper("stage-copy", "--root", root, "--staging", staging, "--manifest", manifest,
                                  "--run-id", "20260824T000000Z-dup00001")
        assert code != 0
        assert result["error"]["code"] == "duplicate-id", result
        assert result["error"]["phase"] == "baseline", result
        assert result["error"]["id"] == "same-record", result
        assert result["error"]["run_id"] == "20260824T000000Z-dup00001", result
        assert {result["error"]["first_path"], result["error"]["second_path"]} == {
            "handbook/a.md", "rollouts/b.md"
        }, result


def test_staging_duplicate():
    with tempfile.TemporaryDirectory(prefix="dsh-memory-staging-duplicate-") as directory:
        root = pathlib.Path(directory) / "memory"
        root.mkdir()
        init_root(root)
        staging = pathlib.Path(directory) / "staging"
        manifest = pathlib.Path(directory) / "manifest.json"
        code, result = run_helper("stage-copy", "--root", root, "--staging", staging, "--manifest", manifest)
        assert code == 0, result
        original = (staging / "handbook/a.md").read_text(encoding="utf-8")
        (staging / "rollouts/b.md").write_text(original, encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest,
                                  "--run-id", "20260824T000001Z-dup00002")
        assert code != 0
        assert result["error"]["code"] == "duplicate-id", result
        assert result["error"]["phase"] == "staging-diff", result
        assert result["error"]["run_id"] == "20260824T000001Z-dup00002", result


def test_failure_state_semantics():
    with tempfile.TemporaryDirectory(prefix="dsh-memory-failure-state-") as directory:
        root = pathlib.Path(directory) / "memory"
        root.mkdir()
        init_root(root)
        run_id = "20260824T000000Z-failure01"
        common = [
            "journal", "--root", root, "--run-id", run_id, "--operation-name", "sync",
            "--started-at", "2026-08-24T00:00:00Z", "--status", "failed",
            "--error-code", "duplicate-id", "--phase", "validating",
            "--candidate-digest", "sha256:test", "--sync-policy-version", "v0.8.1",
        ]
        code, result = run_helper(*common)
        assert code == 0, result
        code, retry = run_helper(
            "retry-check", "--root", root, "--candidate-digest", "sha256:test",
            "--sync-policy-version", "v0.8.1", "--cooldown-seconds", "3600",
        )
        assert code == 0 and retry["value"]["suppressed"] is True, retry
        for index in range(3):
            code, result = run_helper(
                "write-failure-sentinel", "--root", root, "--run-id", f"{run_id}-{index}",
                "--error-code", "duplicate-id", "--phase", "validating", "--candidate-digest", "sha256:test",
            )
            assert code == 0, result
        sentinel = json.loads((root / ".sync/failure-sentinel.json").read_text(encoding="utf-8"))
        assert sentinel["consecutive_failures"] == 3, sentinel
        code, result = run_helper(
            "journal", "--root", root, "--run-id", "20260824T000100Z-skip0001", "--operation-name", "sync",
            "--started-at", "2026-08-24T00:01:00Z", "--status", "skipped-retry", "--error-code", "duplicate-id",
            "--phase", "retry", "--candidate-digest", "sha256:test", "--sync-policy-version", "v0.8.1",
            "--suppress-last-run",
        )
        assert code == 0, result
        last = json.loads((root / ".sync/last-run.json").read_text(encoding="utf-8"))
        assert last["status"] == "failed", last
        skipped = json.loads((root / ".sync/runs/20260824T000100Z-skip0001.json").read_text(encoding="utf-8"))
        assert skipped["status"] == "skipped-retry", skipped


def test_readonly_reference_is_not_payload():
    assert SYNC_APPLY.path_is_payload("README.md") is False
    assert SYNC_APPLY.path_is_readonly("README.md") is True


def test_summary_budget_fails_closed():
    with tempfile.TemporaryDirectory(prefix="dsh-memory-summary-budget-") as directory:
        root = pathlib.Path(directory) / "memory"
        root.mkdir()
        init_root(root)
        staging = pathlib.Path(directory) / "staging"
        manifest = pathlib.Path(directory) / "manifest.json"
        code, result = run_helper("stage-copy", "--root", root, "--staging", staging, "--manifest", manifest)
        assert code == 0, result
        (staging / "summary.md").write_text("x" * (12 * 1024 + 1), encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest)
        assert code != 0
        assert result["error"]["code"] == "summary-too-large", result


def test_missing_provenance():
    # v0.9.1: a newly added handbook record without provenance fails closed;
    # the same record with source_rollouts (or digest/hash) applies cleanly,
    # and modifications to baseline records stay exempt.
    with tempfile.TemporaryDirectory(prefix="dsh-memory-provenance-") as directory:
        root = pathlib.Path(directory) / "memory"
        root.mkdir()
        init_root(root)
        staging = pathlib.Path(directory) / "staging"
        manifest = pathlib.Path(directory) / "manifest.json"
        code, result = run_helper("stage-copy", "--root", root, "--staging", staging, "--manifest", manifest)
        assert code == 0, result
        (staging / "handbook/new.md").write_text(
            "---\nschema_version: 1\nid: hand/new\ntype: decision\n---\nbody\n", encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest)
        assert code != 0, result
        assert result["error"]["code"] == "missing-provenance", result
        assert result["error"]["path"] == "handbook/new.md", result
        # With provenance the same record passes.
        (staging / "handbook/new.md").write_text(
            "---\nschema_version: 1\nid: hand/new\ntype: decision\nsource_rollouts:\n  - rollouts/a.md\n---\nbody\n",
            encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest)
        assert code == 0, result
        # session-digest provenance also satisfies the gate.
        (staging / "handbook/new2.md").write_text(
            "---\nschema_version: 1\nid: hand/new2\ntype: decision\nsource_session_digest: abc123\n---\nbody\n",
            encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest)
        assert code == 0, result
        # Modifying a baseline handbook record stays exempt from the gate.
        (staging / "handbook/a.md").write_text(
            "---\nschema_version: 1\nid: same-record\ntype: fact\n---\nedited body\n", encoding="utf-8")
        code, result = run_helper("diff", "--staging", staging, "--manifest", manifest)
        assert code == 0, result


if __name__ == "__main__":
    test_baseline_duplicate()
    test_staging_duplicate()
    test_failure_state_semantics()
    test_readonly_reference_is_not_payload()
    test_summary_budget_fails_closed()
    test_missing_provenance()
    print("dsh-memory sync failure diagnostics tests passed")
