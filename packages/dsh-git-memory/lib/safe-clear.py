#!/usr/bin/env python3
"""FD-anchored mutations for the DPSK memory repository.

All mutations below are relative to an already-open memory-root descriptor.
That means a target directory switched to a symlink between validation and a
mutation is never traversed outside the memory repository.
"""

import argparse
import json
import os
import re
import stat
import subprocess
import sys
import uuid


TARGETS = ("summary.md", "handbook", "rollouts", "archive")
DIRECTORIES = TARGETS[1:]
TOKEN_RE = re.compile(r"^\.dpsk-memory-clear-[0-9a-f]{32}$")
NOFOLLOW = getattr(os, "O_NOFOLLOW", 0)
DIRECTORY = getattr(os, "O_DIRECTORY", 0)


class SafeClearError(Exception):
    def __init__(self, code):
        super().__init__(code)
        self.code = code


def emit(value):
    print(json.dumps(value, separators=(",", ":")))


def require_fd_support():
    if not NOFOLLOW or not DIRECTORY:
        raise SafeClearError("clear-failed")


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
            raise SafeClearError("unsafe-layout")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def open_regular(directory_fd, name):
    descriptor = os.open(name, os.O_RDONLY | NOFOLLOW, dir_fd=directory_fd)
    try:
        if not stat.S_ISREG(os.fstat(descriptor).st_mode):
            raise SafeClearError("unsafe-layout")
        return descriptor
    except BaseException:
        os.close(descriptor)
        raise


def validate_tree(directory_fd):
    count = 0
    with os.scandir(directory_fd) as entries:
        for entry in entries:
            entry_stat = entry.stat(follow_symlinks=False)
            if stat.S_ISLNK(entry_stat.st_mode):
                raise SafeClearError("unsafe-layout")
            if stat.S_ISDIR(entry_stat.st_mode):
                child_fd = open_directory(directory_fd, entry.name)
                try:
                    count += validate_tree(child_fd)
                finally:
                    os.close(child_fd)
            elif stat.S_ISREG(entry_stat.st_mode):
                file_fd = open_regular(directory_fd, entry.name)
                try:
                    if os.fstat(file_fd).st_size > 0:
                        count += 1
                finally:
                    os.close(file_fd)
            else:
                raise SafeClearError("unsafe-layout")
    return count


def validate_layout(root_fd):
    count = 0
    for target in TARGETS:
        target_stat = lstat_at(root_fd, target)
        if target_stat is None:
            continue
        if stat.S_ISLNK(target_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        if target == "summary.md":
            if not stat.S_ISREG(target_stat.st_mode):
                raise SafeClearError("unsafe-layout")
            summary_fd = open_regular(root_fd, target)
            try:
                if os.fstat(summary_fd).st_size > 0:
                    count += 1
            finally:
                os.close(summary_fd)
            continue
        if not stat.S_ISDIR(target_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        child_fd = open_directory(root_fd, target)
        try:
            count += validate_tree(child_fd)
        finally:
            os.close(child_fd)
    return count


def empty_directory(directory_fd):
    with os.scandir(directory_fd) as entries:
        return next(entries, None) is None


def verify_cleared(root_fd):
    summary_stat = lstat_at(root_fd, "summary.md")
    if summary_stat is None or stat.S_ISLNK(summary_stat.st_mode) or not stat.S_ISREG(summary_stat.st_mode):
        raise SafeClearError("unsafe-layout")
    summary_fd = open_regular(root_fd, "summary.md")
    try:
        if os.fstat(summary_fd).st_size != 0:
            raise SafeClearError("clear-failed")
    finally:
        os.close(summary_fd)
    for directory in DIRECTORIES:
        directory_stat = lstat_at(root_fd, directory)
        if directory_stat is None or stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        directory_fd = open_directory(root_fd, directory)
        try:
            if not empty_directory(directory_fd):
                raise SafeClearError("clear-failed")
        finally:
            os.close(directory_fd)


def remove_empty_replacements(root_fd):
    summary_stat = lstat_at(root_fd, "summary.md")
    if summary_stat is not None:
        if stat.S_ISLNK(summary_stat.st_mode) or not stat.S_ISREG(summary_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        summary_fd = open_regular(root_fd, "summary.md")
        try:
            if os.fstat(summary_fd).st_size != 0:
                raise SafeClearError("clear-failed")
        finally:
            os.close(summary_fd)
        os.unlink("summary.md", dir_fd=root_fd)
    for directory in DIRECTORIES:
        directory_stat = lstat_at(root_fd, directory)
        if directory_stat is None:
            continue
        if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        directory_fd = open_directory(root_fd, directory)
        try:
            if not empty_directory(directory_fd):
                raise SafeClearError("clear-failed")
        finally:
            os.close(directory_fd)
        os.rmdir(directory, dir_fd=root_fd)


def remove_tree_entry(parent_fd, name):
    entry_stat = lstat_at(parent_fd, name)
    if entry_stat is None:
        return
    if stat.S_ISLNK(entry_stat.st_mode) or stat.S_ISREG(entry_stat.st_mode):
        os.unlink(name, dir_fd=parent_fd)
        return
    if not stat.S_ISDIR(entry_stat.st_mode):
        raise SafeClearError("unsafe-layout")
    child_fd = open_directory(parent_fd, name)
    try:
        with os.scandir(child_fd) as entries:
            children = [entry.name for entry in entries]
        for child in children:
            remove_tree_entry(child_fd, child)
    finally:
        os.close(child_fd)
    os.rmdir(name, dir_fd=parent_fd)


def open_stage(root_fd, token):
    if not TOKEN_RE.fullmatch(token):
        raise SafeClearError("clear-failed")
    stage_stat = lstat_at(root_fd, token)
    if stage_stat is None or stat.S_ISLNK(stage_stat.st_mode) or not stat.S_ISDIR(stage_stat.st_mode):
        raise SafeClearError("clear-failed")
    return open_directory(root_fd, token)


def rollback_stage(root_fd, token):
    stage_fd = open_stage(root_fd, token)
    try:
        remove_empty_replacements(root_fd)
        for target in TARGETS:
            if lstat_at(stage_fd, target) is None:
                continue
            if lstat_at(root_fd, target) is not None:
                raise SafeClearError("clear-failed")
            os.rename(target, target, src_dir_fd=stage_fd, dst_dir_fd=root_fd)
        if not empty_directory(stage_fd):
            raise SafeClearError("clear-failed")
    finally:
        os.close(stage_fd)
    os.rmdir(token, dir_fd=root_fd)


def stage(root):
    root_fd = open_root(root)
    token = None
    try:
        count = validate_layout(root_fd)
        for _ in range(8):
            candidate = f".dpsk-memory-clear-{uuid.uuid4().hex}"
            try:
                os.mkdir(candidate, mode=0o700, dir_fd=root_fd)
                token = candidate
                break
            except FileExistsError:
                continue
        if token is None:
            raise SafeClearError("clear-failed")
        stage_fd = open_stage(root_fd, token)
        try:
            for target in TARGETS:
                if lstat_at(root_fd, target) is not None:
                    os.rename(target, target, src_dir_fd=root_fd, dst_dir_fd=stage_fd)
            summary_fd = os.open("summary.md", os.O_WRONLY | os.O_CREAT | os.O_EXCL | NOFOLLOW, 0o600, dir_fd=root_fd)
            os.close(summary_fd)
            for directory in DIRECTORIES:
                os.mkdir(directory, mode=0o700, dir_fd=root_fd)
            verify_cleared(root_fd)
        except BaseException:
            try:
                rollback_stage(root_fd, token)
            except BaseException:
                pass
            raise
        finally:
            os.close(stage_fd)
        return {"ok": True, "value": {"token": token, "dataFileCount": count}}
    finally:
        os.close(root_fd)


def hash_file(root_fd, directory_fd, name):
    file_fd = open_regular(directory_fd, name)
    try:
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
    finally:
        os.close(file_fd)
    if completed.returncode != 0:
        raise SafeClearError("checkpoint-failed")
    object_id = completed.stdout.decode("ascii", "strict").strip()
    if not re.fullmatch(r"[0-9a-f]{40,64}", object_id):
        raise SafeClearError("checkpoint-failed")
    return object_id


def snapshot_directory(root_fd, directory_fd, prefix, entries):
    with os.scandir(directory_fd) as scan:
        children = sorted((entry.name for entry in scan), key=os.fsencode)
    for child in children:
        child_stat = lstat_at(directory_fd, child)
        if child_stat is None or stat.S_ISLNK(child_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        child_path = f"{prefix}/{child}"
        if stat.S_ISDIR(child_stat.st_mode):
            child_fd = open_directory(directory_fd, child)
            try:
                snapshot_directory(root_fd, child_fd, child_path, entries)
            finally:
                os.close(child_fd)
        elif stat.S_ISREG(child_stat.st_mode):
            mode = "100755" if child_stat.st_mode & 0o111 else "100644"
            entries.append({"path": child_path, "mode": mode, "object": hash_file(root_fd, directory_fd, child)})
        else:
            raise SafeClearError("unsafe-layout")


def snapshot_entries(root_fd, parent_fd):
    entries = []
    summary_stat = lstat_at(parent_fd, "summary.md")
    if summary_stat is not None:
        if stat.S_ISLNK(summary_stat.st_mode) or not stat.S_ISREG(summary_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        mode = "100755" if summary_stat.st_mode & 0o111 else "100644"
        entries.append({"path": "summary.md", "mode": mode, "object": hash_file(root_fd, parent_fd, "summary.md")})
    for directory in DIRECTORIES:
        directory_stat = lstat_at(parent_fd, directory)
        if directory_stat is None:
            continue
        if stat.S_ISLNK(directory_stat.st_mode) or not stat.S_ISDIR(directory_stat.st_mode):
            raise SafeClearError("unsafe-layout")
        directory_fd = open_directory(parent_fd, directory)
        try:
            snapshot_directory(root_fd, directory_fd, directory, entries)
        finally:
            os.close(directory_fd)
    return entries


def snapshot(root, token):
    root_fd = open_root(root)
    try:
        stage_fd = open_stage(root_fd, token)
        try:
            return {"ok": True, "value": {"entries": snapshot_entries(root_fd, stage_fd)}}
        finally:
            os.close(stage_fd)
    finally:
        os.close(root_fd)


def snapshot_live(root):
    root_fd = open_root(root)
    try:
        validate_layout(root_fd)
        return {"ok": True, "value": {"entries": snapshot_entries(root_fd, root_fd)}}
    finally:
        os.close(root_fd)


def restore(root, token):
    root_fd = open_root(root)
    try:
        rollback_stage(root_fd, token)
        return {"ok": True, "value": {}}
    finally:
        os.close(root_fd)


def finalize(root, token):
    root_fd = open_root(root)
    try:
        stage_fd = open_stage(root_fd, token)
        os.close(stage_fd)
        remove_tree_entry(root_fd, token)
        return {"ok": True, "value": {}}
    finally:
        os.close(root_fd)


def inspect(root):
    root_fd = open_root(root)
    try:
        return {"ok": True, "value": {"dataFileCount": validate_layout(root_fd)}}
    finally:
        os.close(root_fd)


def verify(root):
    root_fd = open_root(root)
    try:
        verify_cleared(root_fd)
        return {"ok": True, "value": {}}
    finally:
        os.close(root_fd)


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("operation", choices=("inspect", "stage", "snapshot", "snapshot-live", "restore", "finalize", "verify"))
    parser.add_argument("--root", required=True)
    parser.add_argument("--token")
    args = parser.parse_args()
    if not os.path.isabs(args.root):
        raise SafeClearError("clear-failed")
    if args.operation == "inspect":
        return inspect(args.root)
    if args.operation == "stage":
        return stage(args.root)
    if args.operation == "snapshot":
        return snapshot(args.root, args.token or "")
    if args.operation == "snapshot-live":
        return snapshot_live(args.root)
    if args.operation == "restore":
        return restore(args.root, args.token or "")
    if args.operation == "finalize":
        return finalize(args.root, args.token or "")
    return verify(args.root)


if __name__ == "__main__":
    try:
        emit(main())
    except SafeClearError as error:
        emit({"ok": False, "error": {"code": error.code}})
    except OSError:
        emit({"ok": False, "error": {"code": "clear-failed"}})
