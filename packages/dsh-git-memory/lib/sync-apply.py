#!/usr/bin/env python3
"""FD-anchored staging and apply for the DPSK memory synchronizer.

The synchronizer never lets headless DSH touch the live memory root. This
helper owns every host-side step of a sync transaction:

  stage-copy      copy the payload tree into an isolated staging worktree
  verify-staging  reject foreign paths, symlinks, and readonly changes
  diff            report added/modified/deleted payload paths vs the baseline
  mirror-payload  apply a source tree onto the live payload (FD anchored)
  apply           full transaction: verify -> mirror -> git -> (journal later)
  journal         atomically write .sync/last-run.json + runs/<run-id>.json
  finalize        write the journal, .last-sync, and the journal commit

All live mutations are relative to an already-open memory-root descriptor, so
a directory switched to a symlink between validation and a mutation is never
traversed outside the memory repository.
"""

import argparse
import calendar
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid
import shutil

PAYLOAD_NAMES = ("summary.md", "handbook", "rollouts", "archive")
READONLY_NAMES = ("README.md",)
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$")
LOCK_NAME = "operation.lock"
ACTIVE_NAME = "active-run.json"
FAILURE_SENTINEL_NAME = "failure-sentinel.json"
FINALIZE_FAILURE_NAME = "finalize-failure.json"
LOCK_REJECTIONS_NAME = "lock-rejections.log"
DEFAULT_STALE_SECONDS = 6 * 60 * 60
MAX_FILE_BYTES = 1024 * 1024
SUMMARY_BUDGET_BYTES = 12 * 1024
MAX_ADDED_FILES = 50
MAX_TOTAL_CHANGE_BYTES = 5 * 1024 * 1024
METADATA_TYPES = {"preference", "fact", "decision", "procedure", "constraint", "observation"}
METADATA_STATUSES = {"active", "candidate", "conflicted", "superseded", "archived"}
METADATA_CONFIDENCES = {"high", "medium", "low", "unknown"}
ID_RE = re.compile(r"^[a-z0-9][a-z0-9-]*(/[a-z0-9][a-z0-9-]*)?$")
DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class SyncError(Exception):
    def __init__(self, code, details=None):
        super().__init__(code)
        self.code = code
        self.details = details if isinstance(details, dict) else {}


def emit(value):
    print(json.dumps(value, separators=(",", ":")))


def require_fd_support():
    if not NOFOLLOW or not DIRECTORY:
        raise SyncError("sync-failed")


def lstat_at(directory_fd, name):
    try:
        return os.stat(name, dir_fd=directory_fd, follow_symlinks=False)
    except FileNotFoundError:
        return None


def open_root(root):
    require_fd_support()
    return os.open(root, os.O_RDONLY | DIRECTORY | NOFOLLOW)


def open_sync_directory(root_fd, create=False):
    entry_stat = lstat_at(root_fd, ".sync")
    if entry_stat is None:
        if not create:
            return None
        os.mkdir(".sync", mode=0o700, dir_fd=root_fd)
        entry_stat = lstat_at(root_fd, ".sync")
    if entry_stat is None or stat.S_ISLNK(entry_stat.st_mode) or not stat.S_ISDIR(entry_stat.st_mode):
        raise SyncError("unsafe-layout")
    return open_directory(root_fd, ".sync")


def read_json_at(directory_fd, name):
    try:
        descriptor = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=directory_fd)
    except FileNotFoundError:
        return None
    try:
        return json.loads(os.read(descriptor, 1024 * 1024).decode("utf-8"))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None
    finally:
        os.close(descriptor)


def process_alive(pid):
    if not isinstance(pid, int) or pid <= 0:
        return False
    try:
        os.kill(pid, 0)
        return True
    except PermissionError:
        return True
    except OSError:
        return False


def acquire_operation_lock(root, operation, run_id, pid=None, stale_after=DEFAULT_STALE_SECONDS):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=True)
        try:
            lock = {
                "operation": operation,
                "pid": int(pid if pid is not None else os.getpid()),
                "runId": run_id,
                "startedAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }
            for attempt in range(2):
                try:
                    descriptor = os.open(
                        LOCK_NAME,
                        os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW,
                        0o600,
                        dir_fd=sync_fd,
                    )
                    try:
                        payload = (json.dumps(lock, separators=(",", ":")) + "\n").encode("utf-8")
                        os.write(descriptor, payload)
                        os.fsync(descriptor)
                    finally:
                        os.close(descriptor)
                    return {"stale_recovered": attempt == 1}
                except FileExistsError:
                    existing = read_json_at(sync_fd, LOCK_NAME)
                    started = None
                    try:
                        started = calendar.timegm(time.strptime(existing.get("startedAt", ""), "%Y-%m-%dT%H:%M:%SZ"))
                    except (AttributeError, TypeError, ValueError, OverflowError):
                        pass
                    fresh = started is not None and time.time() - started < stale_after
                    if process_alive(existing.get("pid") if isinstance(existing, dict) else None) or fresh:
                        raise SyncError("operation-in-progress")
                    try:
                        os.unlink(LOCK_NAME, dir_fd=sync_fd)
                    except FileNotFoundError:
                        pass
            raise SyncError("operation-in-progress")
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)


def release_operation_lock(root, run_id=None):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is None:
            return {"released": False}
        try:
            existing = read_json_at(sync_fd, LOCK_NAME)
            if existing is not None and run_id is not None and existing.get("runId") != run_id:
                raise SyncError("operation-in-progress")
            try:
                os.unlink(LOCK_NAME, dir_fd=sync_fd)
                return {"released": True}
            except FileNotFoundError:
                return {"released": False}
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)


def write_active_run(root, record):
    root_fd = open_root(root)
    try:
        open_sync = open_sync_directory(root_fd, create=True)
        os.close(open_sync)
        write_journal_file(root_fd, f".sync/{ACTIVE_NAME}", json.dumps(record, separators=(",", ":")) + "\n", 0o600)
        return record
    finally:
        os.close(root_fd)


def clear_active_run(root, run_id=None):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is None:
            return {"cleared": False}
        try:
            existing = read_json_at(sync_fd, ACTIVE_NAME)
            if existing is not None and run_id is not None and existing.get("run_id") != run_id:
                return {"cleared": False}
            try:
                os.unlink(ACTIVE_NAME, dir_fd=sync_fd)
                return {"cleared": True}
            except FileNotFoundError:
                return {"cleared": False}
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)


def validate_preview_id(preview_id):
    if not isinstance(preview_id, str) or not RUN_ID_RE.fullmatch(preview_id):
        raise SyncError("invalid-preview")


def preview_paths(root, preview_id, create=False):
    validate_preview_id(preview_id)
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=create)
        if sync_fd is None:
            return None
        try:
            entry_stat = lstat_at(sync_fd, "previews")
            if entry_stat is None:
                if not create:
                    return None
                os.mkdir("previews", mode=0o700, dir_fd=sync_fd)
                entry_stat = lstat_at(sync_fd, "previews")
            if entry_stat is None or stat.S_ISLNK(entry_stat.st_mode) or not stat.S_ISDIR(entry_stat.st_mode):
                raise SyncError("unsafe-layout")
            previews_fd = open_directory(sync_fd, "previews")
            try:
                preview_stat = lstat_at(previews_fd, preview_id)
                if preview_stat is None:
                    if not create:
                        return None
                    os.mkdir(preview_id, mode=0o700, dir_fd=previews_fd)
                    preview_stat = lstat_at(previews_fd, preview_id)
                if preview_stat is None or stat.S_ISLNK(preview_stat.st_mode) or not stat.S_ISDIR(preview_stat.st_mode):
                    raise SyncError("unsafe-layout")
            finally:
                os.close(previews_fd)
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)
    preview_root = os.path.join(root, ".sync", "previews", preview_id)
    return {
        "preview_root": preview_root,
        "staging": os.path.join(preview_root, "staging"),
        "manifest": os.path.join(preview_root, "manifest.json"),
        "metadata": os.path.join(preview_root, "preview.json"),
    }


def prepare_preview(root, preview_id):
    paths = preview_paths(root, preview_id, create=True)
    staging = paths["staging"]
    if os.path.lexists(staging):
        if os.path.islink(staging) or not os.path.isdir(staging):
            raise SyncError("unsafe-layout")
        if next(os.scandir(staging), None) is not None:
            raise SyncError("preview-exists")
    else:
        os.mkdir(staging, mode=0o700)
    os.chmod(staging, 0o700)
    # Seed the staging payload from the live tree and a baseline manifest
    # exactly like stage-copy does, so a later apply-preview runs the normal
    # transaction against a complete baseline.
    root_fd = open_root(root)
    try:
        staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        try:
            for directory in PAYLOAD_NAMES[1:]:
                if lstat_at(staging_fd, directory) is None:
                    os.mkdir(directory, mode=0o700, dir_fd=staging_fd)
            for relative, entry_stat in walk_live_tree(root_fd):
                file_fd = open_regular(root_fd, relative)
                try:
                    copy_relative(staging_fd, relative, file_fd)
                finally:
                    os.close(file_fd)
            # Detect pre-existing live-root record collisions before creating
            # a baseline manifest. This is diagnostic-only: no record is
            # silently selected or removed.
            scan_duplicate_ids(root_fd, walk_live_tree(root_fd), "baseline")
        finally:
            os.close(staging_fd)
        head_sha = None
        try:
            head_sha = git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip()
        except SyncError:
            pass
        manifest = {
            "schema_version": 1,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "head_sha": head_sha,
            "entries": snapshot_manifest(root_fd),
        }
        write_atomic_path(paths["manifest"], json.dumps(manifest, separators=(",", ":")) + "\n", 0o600)
    finally:
        os.close(root_fd)
    return {"preview_id": preview_id, **paths}


def write_preview(root, preview_id, metadata_json):
    paths = preview_paths(root, preview_id, create=False)
    if paths is None:
        raise SyncError("preview-not-found")
    try:
        metadata = json.loads(metadata_json)
    except (TypeError, json.JSONDecodeError):
        raise SyncError("invalid-preview")
    if metadata.get("preview_id") != preview_id:
        raise SyncError("invalid-preview")
    root_fd = open_root(root)
    try:
        write_journal_file(root_fd, f".sync/previews/{preview_id}/preview.json", json.dumps(metadata, separators=(",", ":")) + "\n", 0o600)
    finally:
        os.close(root_fd)
    return metadata


def read_preview(root, preview_id):
    paths = preview_paths(root, preview_id, create=False)
    if paths is None:
        return None
    try:
        return json.loads(read_text(paths["metadata"]))
    except (OSError, UnicodeDecodeError, json.JSONDecodeError):
        return None


def is_preview_expired(preview, now=None):
    expires_at = preview.get("expires_at") if isinstance(preview, dict) else None
    if not isinstance(expires_at, str):
        return True
    try:
        expires = calendar.timegm(time.strptime(expires_at, "%Y-%m-%dT%H:%M:%SZ"))
    except (ValueError, OverflowError):
        return True
    return time.time() >= expires if now is None else now >= expires


def list_previews(root):
    """Return pending (non-expired) preview metadata, newest first."""
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is None:
            return []
        try:
            entry_stat = lstat_at(sync_fd, "previews")
            if entry_stat is None or stat.S_ISLNK(entry_stat.st_mode) or not stat.S_ISDIR(entry_stat.st_mode):
                raise SyncError("unsafe-layout")
            previews_fd = open_directory(sync_fd, "previews")
            try:
                previews = []
                for name in os.listdir(previews_fd):
                    if not RUN_ID_RE.fullmatch(name):
                        continue
                    metadata = read_preview(root, name)
                    if metadata is None or metadata.get("preview_id") != name:
                        continue
                    if not is_preview_expired(metadata):
                        previews.append(metadata)
            finally:
                os.close(previews_fd)
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)
    return sorted(previews, key=lambda preview: str(preview.get("created_at", "")), reverse=True)


def apply_preview(root, preview_id, run_id, started_at):
    """Apply a pending preview's staged payload with the normal apply
    transaction, then leave the preview on disk for the caller to clean up."""
    metadata = read_preview(root, preview_id)
    if metadata is None:
        raise SyncError("preview-not-found")
    if is_preview_expired(metadata):
        raise SyncError("preview-expired")
    paths = preview_paths(root, preview_id, create=False)
    if paths is None:
        raise SyncError("preview-not-found")
    if not os.path.isdir(paths["staging"]) or os.path.islink(paths["staging"]):
        raise SyncError("preview-not-found")
    return apply_transaction(root, paths["staging"], paths["manifest"], run_id, started_at)


def remove_preview(root, preview_id):
    paths = preview_paths(root, preview_id, create=False)
    if paths is None:
        return {"removed": False}
    shutil.rmtree(paths["preview_root"], ignore_errors=False)
    return {"removed": True}


def recover_active(root):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is None:
            return {"recovered": False}
        try:
            active = read_json_at(sync_fd, ACTIVE_NAME)
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)
    if active is None:
        return {"recovered": False}
    if process_alive(active.get("pid")):
        raise SyncError("operation-in-progress")
    now = time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime())
    record = {
        "schema_version": 1,
        "run_id": active.get("run_id") or f"interrupted-{uuid.uuid4().hex[:8]}",
        "operation": active.get("operation") or "sync",
        "status": "interrupted",
        "phase": active.get("phase") or "unknown",
        "started_at": active.get("started_at") or now,
        "finished_at": now,
        "candidate_sessions": active.get("candidate_sessions", 0),
        "processed_sessions": active.get("processed_sessions", 0),
        "skipped_sessions": active.get("skipped_sessions", 0),
        "changed_paths": active.get("changed_paths", []),
        "recovery_commit": active.get("recovery_commit"),
        "apply_commit": active.get("apply_commit"),
        "staging_digest": active.get("staging_digest"),
        "error_code": "interrupted",
    }
    root_fd = open_root(root)
    try:
        journal_entry(root_fd, record["run_id"], record["operation"], record["status"], record["started_at"], record["finished_at"],
                      record["candidate_sessions"], record["processed_sessions"], record["skipped_sessions"],
                      record["changed_paths"], record["recovery_commit"], record["apply_commit"], record["error_code"],
                      record.get("phase"), record.get("staging_digest"))
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is not None:
            try:
                try:
                    os.unlink(ACTIVE_NAME, dir_fd=sync_fd)
                except FileNotFoundError:
                    pass
            finally:
                os.close(sync_fd)
    finally:
        os.close(root_fd)
    git(root, ["add", "--", ".sync"])
    git(root, ["commit", "-m", f"DPSK memory journal: {record['run_id']}", "--", ".sync"])
    return {"recovered": True, "record": record}


def open_directory(directory_fd, name):
    descriptor = os.open(name, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=directory_fd)
    try:
        if not stat.S_ISDIR(os.fstat(descriptor).st_mode):
            raise SyncError("unsafe-layout")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_regular(directory_fd, name):
    descriptor = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise SyncError("unsafe-layout")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def sha256_fd(file_fd):
    digest = hashlib.sha256()
    while True:
        chunk = os.read(file_fd, 1024 * 1024)
        if not chunk:
            break
        digest.update(chunk)
    return digest.hexdigest()


def path_is_payload(relative_path):
    return relative_path.split("/", 1)[0] in PAYLOAD_NAMES


def path_is_readonly(relative_path):
    return relative_path == "README.md"


def path_is_staging_allowed(relative_path):
    return path_is_payload(relative_path) or path_is_readonly(relative_path)


def git_mode(entry_stat):
    return "100755" if entry_stat.st_mode & 0o111 else "100644"


def walk_tree(directory_fd, prefix):
    """Yield (relative_path, stat) for every regular file; reject anything else."""
    names = sorted(os.listdir(directory_fd), key=os.fsencode)
    for name in names:
        entry_stat = lstat_at(directory_fd, name)
        if entry_stat is None:
            raise SyncError("unsafe-layout")
        relative = f"{prefix}/{name}" if prefix else name
        if stat.S_ISLNK(entry_stat.st_mode):
            raise SyncError("unsafe-layout")
        if stat.S_ISDIR(entry_stat.st_mode):
            child_fd = open_directory(directory_fd, name)
            try:
                yield from walk_tree(child_fd, relative)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_stat.st_mode):
            yield relative, entry_stat
        else:
            raise SyncError("unsafe-layout")


def walk_staging_tree(staging_fd):
    """Files that may exist in a staging worktree: payload + readonly reference."""
    for relative, entry_stat in walk_tree(staging_fd, ""):
        if not path_is_staging_allowed(relative):
            raise SyncError("staging-invalid")
        yield relative, entry_stat


def parse_metadata_scalar(value):
    value = value.strip()
    if len(value) >= 2 and value[0] == value[-1] and value[0] in "\"'":
        return value[1:-1]
    if re.fullmatch(r"-?\d+", value):
        try:
            return int(value)
        except ValueError:
            pass
    return value


def parse_record_metadata(text, relative):
    if relative == "summary.md" or not relative.endswith(".md") or not path_is_payload(relative):
        return None
    if not (text.startswith("---\n") or text.startswith("---\r\n")):
        return None
    match = re.match(r"^---\r?\n([\s\S]*?)\r?\n---\r?\n?", text)
    if match is None:
        raise SyncError("invalid-metadata")
    values = {}
    current_key = None
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        list_match = re.match(r"^[ \t]+-\s+(.+)$", line)
        if list_match and current_key is not None and isinstance(values.get(current_key), list):
            values[current_key].append(parse_metadata_scalar(list_match.group(1)))
            continue
        colon = line.find(":")
        if colon <= 0:
            raise SyncError("invalid-metadata")
        key = line[:colon].strip()
        raw = line[colon + 1:].strip()
        if raw.startswith("|") or raw.startswith(">"):
            raise SyncError("invalid-metadata")
        if raw in ("", "[]", "{}"):
            values[key] = []
            current_key = key
        else:
            values[key] = parse_metadata_scalar(raw)
            current_key = None
    if values.get("schema_version") != 1:
        raise SyncError("invalid-schema-version")
    record_id = values.get("id")
    if not isinstance(record_id, str) or not ID_RE.fullmatch(record_id):
        raise SyncError("invalid-id")
    if values.get("type") is not None and values.get("type") not in METADATA_TYPES:
        raise SyncError("invalid-metadata")
    if values.get("status") is not None and values.get("status") not in METADATA_STATUSES:
        raise SyncError("invalid-metadata")
    if values.get("confidence") is not None and values.get("confidence") not in METADATA_CONFIDENCES:
        raise SyncError("invalid-metadata")
    for field in ("created_at", "updated_at"):
        if values.get(field) is not None and (
            not isinstance(values[field], str) or not DATE_RE.fullmatch(values[field])
        ):
            raise SyncError("invalid-metadata")
    for field in ("tags", "source_rollouts"):
        if field in values and not isinstance(values[field], list):
            raise SyncError("invalid-metadata")
    if any(not isinstance(tag, str) or not tag or len(tag) > 64 for tag in values.get("tags", [])):
        raise SyncError("invalid-metadata")
    for source in values.get("source_rollouts", []):
        if not isinstance(source, str) or not source.startswith("rollouts/") or ".." in source or not source.endswith(".md"):
            raise SyncError("invalid-metadata")
    for field in ("source_hash", "created_by"):
        if values.get(field) is not None and (
            not isinstance(values[field], str) or not values[field] or len(values[field]) > 128
        ):
            raise SyncError("invalid-metadata")
    for field in ("review_after", "expires_at"):
        if values.get(field) is not None and (
            not isinstance(values[field], str) or not DATE_RE.fullmatch(values[field])
        ):
            raise SyncError("invalid-metadata")
    return record_id


def metadata_topic_key(record):
    """Deterministic conflict key: type plus the id's namespace segment."""
    record_type = record.get("type") or "observation"
    record_id = record.get("id") or ""
    slash = record_id.find("/")
    namespace = "" if slash == -1 else record_id[:slash]
    return f"{record_type}:{namespace}"


def is_record_expired(record, now=None):
    """Lazy expiry projection: expires_at earlier than now means expired."""
    expires_at = record.get("expires_at") if isinstance(record, dict) else None
    if not isinstance(expires_at, str):
        return False
    try:
        expires = time.mktime(time.strptime(expires_at, "%Y-%m-%d"))
    except (ValueError, OverflowError):
        return False
    current = time.time() if now is None else now
    return expires <= current


def resolve_topic_conflict(records, now=None):
    """Deterministic winner among records sharing a topic key. Expired records
    never win; status precedence active > candidate > conflicted > superseded >
    archived; newest updated_at wins; smallest id breaks ties."""
    precedence = {"active": 0, "candidate": 1, "conflicted": 2, "superseded": 3, "archived": 4}
    eligible = [record for record in records if not is_record_expired(record, now)]
    if not eligible:
        return None
    return sorted(
        eligible,
        key=lambda record: (
            precedence.get(record.get("status") or "candidate", 1),
            -(record.get("updated_at") or ""),
            record.get("id") or "",
        ),
    )[0]


def duplicate_error(record_id, first_path, second_path, phase, run_id=None):
    details = {
        "phase": phase,
        "id": record_id,
        "first_path": first_path,
        "second_path": second_path,
    }
    if run_id is not None:
        details["run_id"] = run_id
    return SyncError("duplicate-id", details)


def scan_duplicate_ids(directory_fd, file_iterator, phase, run_id=None):
    ids = {}
    for relative, _entry_stat in file_iterator:
        if not relative.endswith(".md") or not path_is_payload(relative):
            continue
        file_fd = open_regular(directory_fd, relative)
        try:
            content = b""
            while True:
                chunk = os.read(file_fd, 1024 * 1024)
                if not chunk:
                    break
                content += chunk
        finally:
            os.close(file_fd)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            continue
        record_id = parse_record_metadata(text, relative)
        if record_id is not None:
            if record_id in ids:
                raise duplicate_error(record_id, ids[record_id], relative, phase, run_id)
            ids[record_id] = relative


def validate_staging_limits(staging_fd, manifest, phase="staging-diff", run_id=None):
    baseline = {entry["path"]: entry for entry in manifest.get("entries", [])}
    observed = {}
    ids = {}
    for relative, entry_stat in walk_staging_tree(staging_fd):
        if entry_stat.st_size > MAX_FILE_BYTES:
            raise SyncError("file-too-large")
        file_fd = open_regular(staging_fd, relative)
        try:
            content = b""
            while True:
                chunk = os.read(file_fd, 1024 * 1024)
                if not chunk:
                    break
                content += chunk
                if len(content) > MAX_FILE_BYTES:
                    raise SyncError("file-too-large")
        finally:
            os.close(file_fd)
        try:
            text = content.decode("utf-8")
        except UnicodeDecodeError:
            raise SyncError("binary-file")
        if "\x00" in text:
            raise SyncError("binary-file")
        if relative == "summary.md" and len(content) > SUMMARY_BUDGET_BYTES:
            raise SyncError("summary-too-large")
        record_id = parse_record_metadata(text, relative)
        if record_id is not None:
            if record_id in ids:
                raise duplicate_error(record_id, ids[record_id], relative, phase, run_id)
            ids[record_id] = relative
        observed[relative] = {"size": len(content), "sha256": hashlib.sha256(content).hexdigest()}
    added = [path for path in observed if path not in baseline and path_is_payload(path)]
    modified = [path for path in observed if path in baseline and baseline[path].get("sha256") != observed[path]["sha256"] and path_is_payload(path)]
    deleted = [path for path in baseline if path not in observed and path_is_payload(path)]
    if len(added) > MAX_ADDED_FILES:
        raise SyncError("too-many-files")
    changed_bytes = sum(observed[path]["size"] for path in added + modified)
    if changed_bytes > MAX_TOTAL_CHANGE_BYTES:
        raise SyncError("change-too-large")
    return {
        "added": sorted(added),
        "modified": sorted(modified),
        "deleted": sorted(deleted),
        "changed_bytes": changed_bytes,
    }


def walk_live_tree(root_fd):
    """Payload + readonly reference files of the live root, skipping bookkeeping."""
    summary = lstat_at(root_fd, "summary.md")
    if summary is not None and stat.S_ISREG(summary.st_mode) and not stat.S_ISLNK(summary.st_mode):
        yield "summary.md", summary
    for directory in PAYLOAD_NAMES[1:]:
        entry_stat = lstat_at(root_fd, directory)
        if entry_stat is None:
            continue
        if stat.S_ISLNK(entry_stat.st_mode) or not stat.S_ISDIR(entry_stat.st_mode):
            raise SyncError("unsafe-layout")
        directory_fd = open_directory(root_fd, directory)
        try:
            yield from walk_tree(directory_fd, directory)
        finally:
            os.close(directory_fd)
    readonly = lstat_at(root_fd, "README.md")
    if readonly is not None and stat.S_ISREG(readonly.st_mode) and not stat.S_ISLNK(readonly.st_mode):
        yield "README.md", readonly


def validate_live_layout(root_fd):
    """Payload paths must be safe when present; missing payload dirs are empty."""
    for name in PAYLOAD_NAMES:
        entry_stat = lstat_at(root_fd, name)
        if entry_stat is None:
            continue
        if stat.S_ISLNK(entry_stat.st_mode):
            raise SyncError("unsafe-layout")
        if name == "summary.md":
            if not stat.S_ISREG(entry_stat.st_mode):
                raise SyncError("unsafe-layout")
        elif not stat.S_ISDIR(entry_stat.st_mode):
            raise SyncError("unsafe-layout")


def copy_file_contents(source_fd, destination_fd):
    while True:
        chunk = os.read(source_fd, 1024 * 1024)
        if not chunk:
            break
        os.write(destination_fd, chunk)


def copy_relative(destination_root_fd, relative, source_fd):
    parts = relative.split("/")
    opened = []
    parent_fd = destination_root_fd
    try:
        for part in parts[:-1]:
            child_stat = lstat_at(parent_fd, part)
            if child_stat is None:
                os.mkdir(part, mode=0o700, dir_fd=parent_fd)
                child_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
            elif stat.S_ISDIR(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode):
                child_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
            else:
                raise SyncError("unsafe-layout")
            opened.append(child_fd)
            parent_fd = child_fd
        destination = os.open(parts[-1], os.O_WRONLY | os.O_CREAT | os.O_TRUNC | NOFOLLOW, 0o600, dir_fd=parent_fd)
        try:
            copy_file_contents(source_fd, destination)
        finally:
            os.close(destination)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def snapshot_manifest(root_fd):
    """Manifest of the live payload + readonly reference at a point in time."""
    entries = []
    for relative, entry_stat in walk_live_tree(root_fd):
        file_fd = open_regular(root_fd, relative)
        try:
            entries.append({
                "path": relative,
                "mode": git_mode(entry_stat),
                "size": entry_stat.st_size,
                "sha256": sha256_fd(file_fd),
            })
        finally:
            os.close(file_fd)
    return entries


def stage_copy(root, staging, manifest_path, run_id=None):
    root_fd = open_root(root)
    try:
        validate_live_layout(root_fd)
        if os.path.lexists(staging):
            if not os.path.isdir(staging) or os.path.islink(staging):
                raise SyncError("sync-failed")
            if next(os.scandir(staging), None) is not None:
                raise SyncError("sync-failed")
        else:
            os.mkdir(staging, mode=0o700)
        os.chmod(staging, 0o700)
        staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
        try:
            for directory in PAYLOAD_NAMES[1:]:
                if lstat_at(staging_fd, directory) is None:
                    os.mkdir(directory, mode=0o700, dir_fd=staging_fd)
            for relative, entry_stat in walk_live_tree(root_fd):
                file_fd = open_regular(root_fd, relative)
                try:
                    copy_relative(staging_fd, relative, file_fd)
                finally:
                    os.close(file_fd)
            # Detect pre-existing live-root record collisions before creating
            # a baseline manifest. This is diagnostic-only: no record is
            # silently selected or removed.
            scan_duplicate_ids(root_fd, walk_live_tree(root_fd), "baseline", run_id)
        finally:
            os.close(staging_fd)
        head_sha = None
        try:
            head_sha = git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip()
        except SyncError:
            # stage-copy may run against a memory root that is not (yet) a Git
            # repository; the baseline manifest still carries the live tree.
            pass
        manifest = {
            "schema_version": 1,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "head_sha": head_sha,
            "entries": snapshot_manifest(root_fd),
        }
        write_atomic_path(manifest_path, json.dumps(manifest, separators=(",", ":")) + "\n", 0o600)
        return {"ok": True, "value": {"staging": staging, "manifest": manifest_path}}
    finally:
        os.close(root_fd)


def verify_staging(root, staging, manifest_path, run_id=None):
    manifest = json.loads(read_text(manifest_path))
    readonly_sha = {entry["path"]: entry["sha256"] for entry in manifest.get("entries", []) if path_is_readonly(entry["path"])}
    staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        limits = validate_staging_limits(staging_fd, manifest, run_id=run_id)
        observed = {}
        for relative, entry_stat in walk_staging_tree(staging_fd):
            file_fd = open_regular(staging_fd, relative)
            try:
                observed[relative] = sha256_fd(file_fd)
            finally:
                os.close(file_fd)
    finally:
        os.close(staging_fd)
    for path, expected in readonly_sha.items():
        if observed.get(path) != expected:
            raise SyncError("staging-invalid")
    return {"ok": True, "value": limits}


def diff_staging(staging, manifest_path, run_id=None):
    manifest = json.loads(read_text(manifest_path))
    baseline = {entry["path"]: entry["sha256"] for entry in manifest.get("entries", [])}
    staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        limits = validate_staging_limits(staging_fd, manifest, run_id=run_id)
        observed = {}
        for relative, entry_stat in walk_staging_tree(staging_fd):
            file_fd = open_regular(staging_fd, relative)
            try:
                observed[relative] = sha256_fd(file_fd)
            finally:
                os.close(file_fd)
    finally:
        os.close(staging_fd)
    added = [path for path in observed if path not in baseline]
    modified = [path for path in observed if path in baseline and baseline[path] != observed[path]]
    deleted = [path for path in baseline if path not in observed]
    return {"ok": True, "value": {
        "added": sorted(added), "modified": sorted(modified), "deleted": sorted(deleted),
        "changed_bytes": limits["changed_bytes"],
    }}


def mirror_payload(root, source):
    """Mirror the source payload tree onto the live root (FD anchored)."""
    root_fd = open_root(root)
    source_fd = os.open(source, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
        validate_live_layout(root_fd)
        observed = []
        for relative, entry_stat in walk_staging_tree(source_fd):
            if not path_is_payload(relative):
                continue  # README.md reference is copied into staging but never applied
            observed.append(relative)
        for relative in observed:
            source_file_fd = open_regular(source_fd, relative)
            try:
                copy_relative(root_fd, relative, source_file_fd)
            finally:
                os.close(source_file_fd)
        remove_extra_payload(root_fd, set(observed))
        return {"ok": True, "value": {"applied": sorted(observed)}}
    finally:
        os.close(source_fd)
        os.close(root_fd)


def remove_extra_payload(root_fd, keep):
    """Delete payload files in the live tree that are not present in staging.
    Directory skeletons are preserved so future syncs always have a place to write."""
    for directory in PAYLOAD_NAMES[1:]:
        directory_stat = lstat_at(root_fd, directory)
        if directory_stat is None:
            os.mkdir(directory, mode=0o700, dir_fd=root_fd)
            continue
        if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
            raise SyncError("unsafe-layout")
        directory_fd = open_directory(root_fd, directory)
        try:
            remove_extra_tree(directory_fd, directory, keep)
        finally:
            os.close(directory_fd)
    summary_stat = lstat_at(root_fd, "summary.md")
    if summary_stat is not None and "summary.md" not in keep:
        if stat.S_ISLNK(summary_stat.st_mode) or not stat.S_ISREG(summary_stat.st_mode):
            raise SyncError("unsafe-layout")
        os.unlink("summary.md", dir_fd=root_fd)


def remove_extra_tree(directory_fd, prefix, keep):
    names = sorted(os.listdir(directory_fd), key=os.fsencode)
    for name in names:
        entry_stat = lstat_at(directory_fd, name)
        if entry_stat is None:
            raise SyncError("unsafe-layout")
        relative = f"{prefix}/{name}"
        if stat.S_ISDIR(entry_stat.st_mode) and not stat.S_ISLNK(entry_stat.st_mode):
            child_fd = open_directory(directory_fd, name)
            try:
                remove_extra_tree(child_fd, relative, keep)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(entry_stat.st_mode):
            if relative not in keep:
                os.unlink(name, dir_fd=directory_fd)
        else:
            raise SyncError("unsafe-layout")


def empty_directory(directory_fd, name):
    child_fd = open_directory(directory_fd, name)
    try:
        return len(os.listdir(child_fd)) == 0
    finally:
        os.close(child_fd)


def git(root, args, environment=None):
    completed = subprocess.run(
        ["/usr/bin/git", "-C", root, *args],
        env=environment if environment is not None else os.environ,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        check=False,
    )
    if completed.returncode != 0:
        raise SyncError("commit-failed")
    return completed.stdout


def snapshot_live_entries(root_fd):
    """Git entries for the live payload tree (summary + three dirs)."""
    entries = []
    for relative, entry_stat in walk_live_tree(root_fd):
        if not path_is_payload(relative):
            continue  # README.md reference is not part of the payload tree
        file_fd = open_regular(root_fd, relative)
        try:
            object_id = hash_object(root_fd, file_fd)
        finally:
            os.close(file_fd)
        entries.append({"path": relative, "mode": git_mode(entry_stat), "object": object_id})
    return entries


def hash_object(root_fd, file_fd):
    with os.fdopen(os.dup(file_fd), "rb", closefd=True) as source:
        completed = subprocess.run(
            ["/usr/bin/git", "hash-object", "-w", "--stdin"],
            pass_fds=(root_fd,),
            preexec_fn=lambda: os.fchdir(root_fd),
            stdin=source,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            check=False,
        )
    if completed.returncode != 0:
        raise SyncError("checkpoint-failed")
    object_id = completed.stdout.decode("ascii", "strict").strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", object_id):
        raise SyncError("checkpoint-failed")
    return object_id


def build_target_commit(root, base, entries, message):
    """Build a commit whose tree carries the given payload entries over base."""
    alternate = os.path.join(root, ".git", f"dpsk-memory-alt-{uuid.uuid4().hex[:12]}")
    environment = {**os.environ, "GIT_INDEX_FILE": alternate}
    try:
        git(root, ["read-tree", base], environment=environment)
        for entry in entries:
            git(root, ["update-index", "--add", "--cacheinfo", f"{entry['mode']},{entry['object']},{entry['path']}"], environment=environment)
        tree = git(root, ["write-tree"], environment=environment).decode("ascii", "strict").strip()
        base_tree = git(root, ["rev-parse", f"{base}^{{tree}}"]).decode("ascii", "strict").strip()
        if tree == base_tree:
            return None
        return git(root, ["commit-tree", tree, "-p", base, "-m", message], environment=environment).decode("ascii", "strict").strip()
    finally:
        try:
            os.unlink(alternate)
        except OSError:
            pass


def replace_current_index(root, entries):
    raw = git(root, ["ls-files", "-s", "-z", "--", *PAYLOAD_NAMES]).decode("utf-8", "replace")
    indexed = [entry.split("\t", 1)[1] for entry in raw.split("\0") if entry]
    if indexed:
        git(root, ["update-index", "--force-remove", "--", *indexed])
    for entry in entries:
        git(root, ["update-index", "--add", "--cacheinfo", f"{entry['mode']},{entry['object']},{entry['path']}"])


def apply_transaction(root, staging, manifest_path, run_id, started_at):
    manifest = json.loads(read_text(manifest_path))
    verify_staging(root, staging, manifest_path, run_id)
    difference = diff_staging(staging, manifest_path, run_id)["value"]
    changed_paths = difference["added"] + difference["modified"] + difference["deleted"]
    if not changed_paths:
        return {"ok": True, "value": {
            "status": "no_change", "run_id": run_id, "changed_paths": [],
            "recovery_commit": None, "apply_commit": None,
        }}
    head = git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip()
    if head != manifest.get("head_sha"):
        raise SyncError("live-memory-changed")
    root_fd = open_root(root)
    try:
        current = {entry["path"]: entry["sha256"] for entry in snapshot_manifest(root_fd)}
        baseline = {entry["path"]: entry["sha256"] for entry in manifest.get("entries", [])}
        if current != baseline:
            raise SyncError("live-memory-changed")
        recovery_entries = snapshot_live_entries(root_fd)
        recovery_commit = build_target_commit(root, head, recovery_entries, f"DPSK memory recovery checkpoint: {run_id}")
        if recovery_commit is None:
            recovery_commit = head
        mirror_payload(root, staging)
        applied_entries = snapshot_live_entries(root_fd)
        apply_commit = build_target_commit(root, recovery_commit, applied_entries, f"DPSK memory sync applied: {run_id}")
        if apply_commit is None:
            raise SyncError("sync-failed")
        replace_current_index(root, applied_entries)
        git(root, ["update-ref", "HEAD", apply_commit, head])
    finally:
        os.close(root_fd)
    return {"ok": True, "value": {
        "status": "applied", "run_id": run_id, "changed_paths": sorted(changed_paths),
        "recovery_commit": recovery_commit, "apply_commit": apply_commit,
    }}


def read_text(path):
    with open(path, "r", encoding="utf-8") as handle:
        return handle.read()


def write_atomic_path(path, data, mode):
    directory, name = os.path.split(path)
    os.makedirs(directory, mode=0o700, exist_ok=True)
    descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | NOFOLLOW, mode)
    try:
        os.write(descriptor, data.encode("utf-8"))
    finally:
        os.close(descriptor)
    os.chmod(path, mode)


def write_journal_file(root_fd, relative, data, mode):
    parts = relative.split("/")
    opened = []
    parent_fd = root_fd
    try:
        for part in parts[:-1]:
            child_stat = lstat_at(parent_fd, part)
            if child_stat is None:
                os.mkdir(part, mode=0o700, dir_fd=parent_fd)
                child_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
            elif stat.S_ISDIR(child_stat.st_mode) and not stat.S_ISLNK(child_stat.st_mode):
                child_fd = os.open(part, os.O_RDONLY | DIRECTORY | NOFOLLOW, dir_fd=parent_fd)
            else:
                raise SyncError("unsafe-layout")
            opened.append(child_fd)
            parent_fd = child_fd
        temporary = f".{parts[-1]}.tmp-{os.getpid()}-{uuid.uuid4().hex[:8]}"
        descriptor = os.open(temporary, os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, mode, dir_fd=parent_fd)
        try:
            os.write(descriptor, data.encode("utf-8"))
        finally:
            os.close(descriptor)
        os.chmod(temporary, mode, dir_fd=parent_fd)
        os.rename(temporary, parts[-1], src_dir_fd=parent_fd, dst_dir_fd=parent_fd)
    finally:
        for fd in reversed(opened):
            os.close(fd)


def append_sync_log(root, name, line):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=True)
        try:
            descriptor = os.open(name, os.O_WRONLY | os.O_CREAT | os.O_APPEND | NOFOLLOW, 0o600, dir_fd=sync_fd)
            try:
                os.write(descriptor, (line.rstrip("\n") + "\n").encode("utf-8"))
                os.fsync(descriptor)
            finally:
                os.close(descriptor)
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)
    return {"written": True, "name": name}


def read_run_records(root):
    try:
        names = sorted(os.listdir(os.path.join(root, ".sync", "runs")))
    except OSError:
        return []
    records = []
    for name in names:
        if not name.endswith(".json"):
            continue
        try:
            records.append(json.loads(read_text(os.path.join(root, ".sync", "runs", name))))
        except (OSError, UnicodeDecodeError, json.JSONDecodeError):
            continue
    return records


def retry_check(root, candidate_digest, policy_version, cooldown_seconds=3600, now=None):
    if not candidate_digest or not policy_version:
        return {"suppressed": False}
    current = time.time() if now is None else now
    matching = [record for record in read_run_records(root)
                if record.get("candidate_digest") == candidate_digest
                and record.get("sync_policy_version") == policy_version
                and record.get("status") == "failed"]
    if not matching:
        return {"suppressed": False}
    latest = sorted(matching, key=lambda record: record.get("finished_at") or "", reverse=True)[0]
    finished = latest.get("finished_at")
    try:
        failed_at = calendar.timegm(time.strptime(finished, "%Y-%m-%dT%H:%M:%SZ"))
    except (TypeError, ValueError, OverflowError):
        return {"suppressed": False}
    retry_at = failed_at + max(0, cooldown_seconds)
    if current < retry_at:
        return {
            "suppressed": True,
            "error_code": latest.get("error_code"),
            "retry_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(retry_at)),
            "run_id": latest.get("run_id"),
        }
    return {"suppressed": False}


def write_failure_sentinel(root, error_code, run_id=None, candidate_digest=None, phase=None):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=True)
        try:
            existing = read_json_at(sync_fd, FAILURE_SENTINEL_NAME)
        finally:
            os.close(sync_fd)
        previous_count = existing.get("consecutive_failures", 0) if isinstance(existing, dict) else 0
        same_error = isinstance(existing, dict) and existing.get("error_code") == error_code and existing.get("candidate_digest") == candidate_digest
        record = {
            "schema_version": 1,
            "error_code": error_code,
            "consecutive_failures": previous_count + 1 if same_error else 1,
            "first_failed_at": existing.get("first_failed_at") if same_error else time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "last_failed_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "run_id": run_id,
            "candidate_digest": candidate_digest,
            "phase": phase,
        }
        write_journal_file(root_fd, f".sync/{FAILURE_SENTINEL_NAME}", json.dumps(record, separators=(",", ":")) + "\n", 0o600)
        return record
    finally:
        os.close(root_fd)


def clear_failure_sentinel(root):
    root_fd = open_root(root)
    try:
        sync_fd = open_sync_directory(root_fd, create=False)
        if sync_fd is None:
            return {"cleared": False}
        try:
            try:
                os.unlink(FAILURE_SENTINEL_NAME, dir_fd=sync_fd)
                return {"cleared": True}
            except FileNotFoundError:
                return {"cleared": False}
        finally:
            os.close(sync_fd)
    finally:
        os.close(root_fd)


def write_finalize_failure(root, run_id=None, candidate_digest=None):
    root_fd = open_root(root)
    try:
        record = {
            "schema_version": 1,
            "error_code": "finalize-failed",
            "run_id": run_id,
            "candidate_digest": candidate_digest,
            "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        }
        write_journal_file(root_fd, f".sync/{FINALIZE_FAILURE_NAME}", json.dumps(record, separators=(",", ":")) + "\n", 0o600)
        return record
    finally:
        os.close(root_fd)


def journal_entry(root_fd, run_id, operation, status, started_at, finished_at,
                  candidate_sessions=0, processed_sessions=0, skipped_sessions=0,
                  changed_paths=None, recovery_commit=None, apply_commit=None,
                  error_code=None, phase=None, staging_digest=None,
                  duration_ms=None, rejected_file_count=0, changed_path_count=None,
                  candidate_digest=None, sync_policy_version=None, update_last_run=True,
                  error_details=None, processed_chunk_count=0,
                  deferred_candidate_count=0, rejected_candidate_count=0):
    record = {
        "schema_version": 1,
        "run_id": run_id,
        "operation": operation,
        "status": status,
        "started_at": started_at,
        "finished_at": finished_at,
        "candidate_sessions": candidate_sessions,
        "processed_sessions": processed_sessions,
        "skipped_sessions": skipped_sessions,
        "changed_paths": sorted(changed_paths or []),
        "recovery_commit": recovery_commit,
        "apply_commit": apply_commit,
        "error_code": error_code,
        "phase": phase,
        "staging_digest": staging_digest,
        "candidate_digest": candidate_digest,
        "sync_policy_version": sync_policy_version,
        "error_details": error_details if isinstance(error_details, dict) else None,
        "duration_ms": duration_ms,
        "rejected_file_count": rejected_file_count,
        "changed_path_count": changed_path_count if changed_path_count is not None else len(changed_paths or []),
        "processed_chunk_count": processed_chunk_count,
        "deferred_candidate_count": deferred_candidate_count,
        "rejected_candidate_count": rejected_candidate_count,
    }
    write_journal_file(root_fd, f".sync/runs/{run_id}.json", json.dumps(record, separators=(",", ":")) + "\n", 0o600)
    if update_last_run:
        last = {key: record[key] for key in (
            "run_id", "operation", "status", "started_at", "finished_at",
            "changed_paths", "recovery_commit", "apply_commit", "error_code", "phase",
            "staging_digest", "candidate_digest", "sync_policy_version", "duration_ms",
            "rejected_file_count", "changed_path_count",
            "processed_chunk_count", "deferred_candidate_count", "rejected_candidate_count",
        )}
        write_journal_file(root_fd, ".sync/last-run.json", json.dumps(last, separators=(",", ":")) + "\n", 0o600)
    return record


def finalize(root, run_id, record, last_sync_ts):
    root_fd = open_root(root)
    try:
        validate_live_layout(root_fd)
        if last_sync_ts is not None:
            write_journal_file(root_fd, ".last-sync", str(last_sync_ts) + "\n", 0o600)
        journal_entry(root_fd, run_id, record["operation"], record["status"], record["started_at"],
                      record["finished_at"], record["candidate_sessions"], record["processed_sessions"],
                      record["skipped_sessions"], record["changed_paths"], record["recovery_commit"],
                      record["apply_commit"], record["error_code"], record.get("phase"),
                      record.get("staging_digest"), record.get("duration_ms"),
                      record.get("rejected_file_count", 0), record.get("changed_path_count"),
                      record.get("candidate_digest"), record.get("sync_policy_version"),
                      error_details=record.get("error_details"),
                      processed_chunk_count=record.get("processed_chunk_count", 0),
                      deferred_candidate_count=record.get("deferred_candidate_count", 0),
                      rejected_candidate_count=record.get("rejected_candidate_count", 0))
    finally:
        os.close(root_fd)
    git(root, ["add", "--", ".sync", ".last-sync"])
    git(root, ["commit", "-m", f"DPSK memory journal: {run_id}", "--", ".sync", ".last-sync"])
    return git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=(
        "stage-copy", "verify-staging", "diff", "mirror-payload", "apply", "journal", "finalize",
        "acquire-lock", "release-lock", "write-active", "clear-active",
        "prepare-preview", "write-preview", "read-preview", "remove-preview", "recover-active",
        "apply-preview", "list-previews", "lock-rejection", "retry-check",
        "write-failure-sentinel", "clear-failure-sentinel", "write-finalize-failure",
    ))
    parser.add_argument("--root")
    parser.add_argument("--staging")
    parser.add_argument("--manifest")
    parser.add_argument("--run-id")
    parser.add_argument("--started-at")
    parser.add_argument("--status")
    parser.add_argument("--operation-name", dest="operation_name")
    parser.add_argument("--last-sync", dest="last_sync")
    parser.add_argument("--candidate-sessions", dest="candidate_sessions", type=int, default=0)
    parser.add_argument("--processed-sessions", dest="processed_sessions", type=int, default=0)
    parser.add_argument("--skipped-sessions", dest="skipped_sessions", type=int, default=0)
    parser.add_argument("--changed-paths", dest="changed_paths")
    parser.add_argument("--recovery-commit", dest="recovery_commit")
    parser.add_argument("--apply-commit", dest="apply_commit")
    parser.add_argument("--error-code", dest="error_code")
    parser.add_argument("--pid", type=int)
    parser.add_argument("--stale-after", type=int, default=DEFAULT_STALE_SECONDS)
    parser.add_argument("--preview-json", dest="preview_json")
    parser.add_argument("--phase")
    parser.add_argument("--staging-digest", dest="staging_digest")
    parser.add_argument("--duration-ms", dest="duration_ms", type=int)
    parser.add_argument("--rejected-file-count", dest="rejected_file_count", type=int, default=0)
    parser.add_argument("--processed-chunk-count", dest="processed_chunk_count", type=int, default=0)
    parser.add_argument("--deferred-candidate-count", dest="deferred_candidate_count", type=int, default=0)
    parser.add_argument("--rejected-candidate-count", dest="rejected_candidate_count", type=int, default=0)
    parser.add_argument("--candidate-digest", dest="candidate_digest")
    parser.add_argument("--sync-policy-version", dest="sync_policy_version")
    parser.add_argument("--cooldown-seconds", dest="cooldown_seconds", type=int, default=3600)
    parser.add_argument("--suppress-last-run", dest="suppress_last_run", action="store_true")
    parser.add_argument("--error-id", dest="error_id")
    parser.add_argument("--first-path", dest="first_path")
    parser.add_argument("--second-path", dest="second_path")
    args = parser.parse_args()
    if args.root is not None and not os.path.isabs(args.root):
        raise SyncError("sync-failed")
    if args.operation == "acquire-lock":
        return {"ok": True, "value": acquire_operation_lock(
            args.root, args.operation_name or "sync", args.run_id, args.pid, args.stale_after,
        )}
    if args.operation == "release-lock":
        return {"ok": True, "value": release_operation_lock(args.root, args.run_id)}
    if args.operation == "write-active":
        return {"ok": True, "value": write_active_run(args.root, {
            "schema_version": 1,
            "run_id": args.run_id,
            "operation": args.operation_name or "sync",
            "status": "running",
            "phase": args.phase or args.status or "staging",
            "pid": int(args.pid if args.pid is not None else os.getpid()),
            "started_at": args.started_at or time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
        })}
    if args.operation == "clear-active":
        return {"ok": True, "value": clear_active_run(args.root, args.run_id)}
    if args.operation == "prepare-preview":
        return {"ok": True, "value": prepare_preview(args.root, args.run_id)}
    if args.operation == "write-preview":
        return {"ok": True, "value": write_preview(args.root, args.run_id, args.preview_json)}
    if args.operation == "read-preview":
        return {"ok": True, "value": read_preview(args.root, args.run_id)}
    if args.operation == "remove-preview":
        return {"ok": True, "value": remove_preview(args.root, args.run_id)}
    if args.operation == "apply-preview":
        result = apply_preview(
            args.root, args.run_id, args.operation_name or "preview", args.started_at,
        )
        return result if result.get("ok") is not None else {"ok": True, "value": result}
    if args.operation == "list-previews":
        return {"ok": True, "value": {"previews": list_previews(args.root)}}
    if args.operation == "lock-rejection":
        return {"ok": True, "value": append_sync_log(
            args.root, LOCK_REJECTIONS_NAME, json.dumps({
                "schema_version": 1,
                "run_id": args.run_id,
                "operation": args.operation_name or "sync",
                "error_code": args.error_code or "operation-in-progress",
                "at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            }, separators=(",", ":")),
        )}
    if args.operation == "retry-check":
        return {"ok": True, "value": retry_check(
            args.root, args.candidate_digest, args.sync_policy_version, args.cooldown_seconds,
        )}
    if args.operation == "write-failure-sentinel":
        return {"ok": True, "value": write_failure_sentinel(
            args.root, args.error_code or "sync-failed", args.run_id, args.candidate_digest, args.phase,
        )}
    if args.operation == "clear-failure-sentinel":
        return {"ok": True, "value": clear_failure_sentinel(args.root)}
    if args.operation == "write-finalize-failure":
        return {"ok": True, "value": write_finalize_failure(args.root, args.run_id, args.candidate_digest)}
    if args.operation == "recover-active":
        return {"ok": True, "value": recover_active(args.root)}
    if args.operation == "stage-copy":
        return stage_copy(args.root, args.staging, args.manifest, args.run_id)
    if args.operation == "verify-staging":
        return verify_staging(args.root, args.staging, args.manifest, args.run_id)
    if args.operation == "diff":
        return diff_staging(args.staging, args.manifest, args.run_id)
    if args.operation == "mirror-payload":
        return mirror_payload(args.root, args.staging)
    if args.operation == "apply":
        return apply_transaction(args.root, args.staging, args.manifest, args.run_id, args.started_at)
    if args.operation == "journal":
        root_fd = open_root(args.root)
        try:
            return {"ok": True, "value": journal_entry(
                root_fd, args.run_id, args.operation_name or "sync", args.status,
                args.started_at, time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                args.candidate_sessions, args.processed_sessions, args.skipped_sessions,
                args.changed_paths.split(",") if args.changed_paths else [],
                args.recovery_commit, args.apply_commit, args.error_code, args.phase,
                args.staging_digest, args.duration_ms, args.rejected_file_count,
                candidate_digest=args.candidate_digest, sync_policy_version=args.sync_policy_version,
                update_last_run=not args.suppress_last_run,
                error_details={key: value for key, value in {
                    "id": args.error_id, "first_path": args.first_path, "second_path": args.second_path,
                }.items() if value is not None},
                processed_chunk_count=args.processed_chunk_count,
                deferred_candidate_count=args.deferred_candidate_count,
                rejected_candidate_count=args.rejected_candidate_count)}
        finally:
            os.close(root_fd)
    if args.operation == "finalize":
        record = {"operation": args.operation_name or "sync", "status": args.status,
                  "started_at": args.started_at,
                  "finished_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
                  "candidate_sessions": args.candidate_sessions,
                  "processed_sessions": args.processed_sessions,
                  "skipped_sessions": args.skipped_sessions,
                  "changed_paths": args.changed_paths.split(",") if args.changed_paths else [],
                  "recovery_commit": args.recovery_commit, "apply_commit": args.apply_commit,
                  "error_code": args.error_code, "phase": args.phase,
                  "staging_digest": args.staging_digest, "candidate_digest": args.candidate_digest,
                  "sync_policy_version": args.sync_policy_version, "duration_ms": args.duration_ms,
                  "rejected_file_count": args.rejected_file_count,
                  "processed_chunk_count": args.processed_chunk_count,
                  "deferred_candidate_count": args.deferred_candidate_count,
                  "rejected_candidate_count": args.rejected_candidate_count,
                  "error_details": {key: value for key, value in {
                      "id": args.error_id, "first_path": args.first_path, "second_path": args.second_path,
                  }.items() if value is not None}}
        return {"ok": True, "value": {"journal_commit": finalize(args.root, args.run_id, record, args.last_sync)}}
    raise SyncError("sync-failed")


if __name__ == "__main__":
    try:
        emit(main())
    except SyncError as error:
        emit({"ok": False, "error": {"code": error.code, **error.details}})
        sys.exit(1)
    except OSError:
        emit({"ok": False, "error": {"code": "sync-failed"}})
        sys.exit(1)
