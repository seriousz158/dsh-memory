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
import hashlib
import json
import os
import re
import stat
import subprocess
import sys
import time
import uuid

PAYLOAD_NAMES = ("summary.md", "handbook", "rollouts", "archive")
READONLY_NAMES = ("README.md",)
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)
RUN_ID_RE = re.compile(r"^[0-9]{8}T[0-9]{6}Z-[0-9a-f]{8}$")


class SyncError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


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


def stage_copy(root, staging, manifest_path):
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
        finally:
            os.close(staging_fd)
        manifest = {
            "schema_version": 1,
            "created_at": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()),
            "head_sha": git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip(),
            "entries": snapshot_manifest(root_fd),
        }
        write_atomic_path(manifest_path, json.dumps(manifest, separators=(",", ":")) + "\n", 0o600)
        return {"ok": True, "value": {"staging": staging, "manifest": manifest_path}}
    finally:
        os.close(root_fd)


def verify_staging(root, staging, manifest_path):
    manifest = json.loads(read_text(manifest_path))
    readonly_sha = {entry["path"]: entry["sha256"] for entry in manifest.get("entries", []) if path_is_readonly(entry["path"])}
    staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
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
    return {"ok": True, "value": {}}


def diff_staging(staging, manifest_path):
    manifest = json.loads(read_text(manifest_path))
    baseline = {entry["path"]: entry["sha256"] for entry in manifest.get("entries", [])}
    staging_fd = os.open(staging, os.O_RDONLY | DIRECTORY | NOFOLLOW)
    try:
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
    return {"ok": True, "value": {"added": added, "modified": modified, "deleted": deleted}}


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
    verify_staging(root, staging, manifest_path)
    difference = diff_staging(staging, manifest_path)["value"]
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


def journal_entry(root_fd, run_id, operation, status, started_at, finished_at,
                  candidate_sessions=0, processed_sessions=0, skipped_sessions=0,
                  changed_paths=None, recovery_commit=None, apply_commit=None,
                  error_code=None):
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
    }
    write_journal_file(root_fd, f".sync/runs/{run_id}.json", json.dumps(record, separators=(",", ":")) + "\n", 0o600)
    last = {key: record[key] for key in (
        "run_id", "operation", "status", "started_at", "finished_at",
        "changed_paths", "recovery_commit", "apply_commit", "error_code",
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
                      record["apply_commit"], record["error_code"])
    finally:
        os.close(root_fd)
    git(root, ["add", "--", ".sync", ".last-sync"])
    git(root, ["commit", "-m", f"DPSK memory journal: {run_id}", "--", ".sync", ".last-sync"])
    return git(root, ["rev-parse", "HEAD"]).decode("ascii", "strict").strip()


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=(
        "stage-copy", "verify-staging", "diff", "mirror-payload", "apply", "journal", "finalize",
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
    args = parser.parse_args()
    if args.root is not None and not os.path.isabs(args.root):
        raise SyncError("sync-failed")
    if args.operation == "stage-copy":
        return stage_copy(args.root, args.staging, args.manifest)
    if args.operation == "verify-staging":
        return verify_staging(args.root, args.staging, args.manifest)
    if args.operation == "diff":
        return diff_staging(args.staging, args.manifest)
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
                args.recovery_commit, args.apply_commit, args.error_code)}
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
                  "error_code": args.error_code}
        return {"ok": True, "value": {"journal_commit": finalize(args.root, args.run_id, record, args.last_sync)}}
    raise SyncError("sync-failed")


if __name__ == "__main__":
    try:
        emit(main())
    except SyncError as error:
        emit({"ok": False, "error": {"code": error.code}})
    except OSError:
        emit({"ok": False, "error": {"code": "sync-failed"}})
