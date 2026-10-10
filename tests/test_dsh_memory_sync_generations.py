"""Zero-provider desktop session discovery: generic generations, self/tmp exclusion, active locks."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import sys
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
NOW = time.time()


def fixture():
    base = Path(tempfile.mkdtemp(prefix="dsh-generation-scan-"))
    home, memory = base / "dsh", base / "memory"
    env = {**os.environ, "HOME": str(base), "DSH_HOME": str(home), "DSH_MEMORY_ROOT": str(memory), "DSH_BIN": "/does-not-exist-no-provider"}
    env.pop("DSH_MEMORY_SYNC_INCLUDE_TMP", None)
    subprocess.run([str(ROOT / "integrations/dsh/dsh-memory-init")], env=env, check=True, capture_output=True)
    marker = memory / ".last-sync"
    marker.touch()
    os.utime(marker, (NOW - 20000, NOW - 20000))
    return home, memory, env


def log(home, relative, filename, age=7200):
    path = home / "sessions" / relative / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("synthetic scan-only fixture")
    os.utime(path, (NOW - age, NOW - age))
    (path.parent / "session.lock").touch()
    return path


def scan(env, expected_code=0):
    result = subprocess.run(["zsh", str(ROOT / "integrations/dsh/dsh-memory-sync"), "--scan-only", "--json"], env=env, text=True, capture_output=True)
    assert result.returncode == expected_code, (result.returncode, result.stdout, result.stderr)
    return json.loads(result.stdout) if expected_code == 0 else result.stderr


def paths(value):
    return {entry["path"] for entry in value["candidates"]}


home, memory, env = fixture()
# Desktop 0.2 layout: <cwd-slug>/<uuid>/session.v4.jsonl.zstd and <cwd-slug>/session-<uuid>/.
v4 = log(home, "--Users-me-projects--/0d611b15", "session.v4.jsonl.zstd")
v4_prefixed = log(home, "--Users-me-projects--/session-5b7697c6", "session.v4.jsonl.zstd")
# Only the highest generation in one session directory is a candidate.
log(home, "--Users-me-work--/migrated", "session.jsonl.zstd")
log(home, "--Users-me-work--/migrated", "session.v3.jsonl.zstd")
migrated_v4 = log(home, "--Users-me-work--/migrated", "session.v4.jsonl.zstd")
# Generations are parsed, not enumerated: v10 outranks v9 numerically.
log(home, "--Users-me-work--/future", "session.v9.jsonl.zstd")
future = log(home, "--Users-me-work--/future", "session.v10.jsonl.zstd")
# The synchronizer's own staging runs and throwaway tmp cwds are never memory sources.
log(home, "--private-var-folders-65-x-T-dsh-memory-sync-70812-staging--/session-e1670344", "session.v4.jsonl.zstd")
tmp_session = log(home, "--private-tmp--/session-5a8777d6", "session.v4.jsonl.zstd")
# A still-active V4 log hides an older idle generation instead of exposing it.
log(home, "--Users-me-work--/busy", "session.v3.jsonl.zstd")
log(home, "--Users-me-work--/busy", "session.v4.jsonl.zstd", age=10)

value = scan(env)
assert paths(value) == {str(v4), str(v4_prefixed), str(migrated_v4), str(future)}, value

# Opt-in keeps tmp cwds, but the synchronizer's own staging stays excluded.
included = scan({**env, "DSH_MEMORY_SYNC_INCLUDE_TMP": "1"})
assert paths(included) == {str(v4), str(v4_prefixed), str(migrated_v4), str(future), str(tmp_session)}, included

# A session whose lock is held by a live process is still being written, even
# when its mtime already passes the idle window.
holder = subprocess.Popen([sys.executable, "-c", "import sys,time; f=open(sys.argv[1],'a'); print('ready', flush=True); time.sleep(60)", str(v4.parent / "session.lock")], stdout=subprocess.PIPE, text=True)
try:
    assert holder.stdout.readline().strip() == "ready"
    held = scan(env)
    assert str(v4) not in paths(held), held
    assert str(v4_prefixed) in paths(held), held
finally:
    holder.kill()
    holder.wait()

# A partially delivered older generation must be reconciled before a newer one.
pending = memory / ".sync/pending-candidates.json"
pending.parent.mkdir(exist_ok=True)
old_v3 = migrated_v4.parent / "session.v3.jsonl.zstd"
state = {"schema_version": 2, "entries": {str(old_v3): {"digest": hashlib.sha256(old_v3.read_bytes()).hexdigest(), "next_chunk": 1, "chunk_total": 2, "complete": False}}}
pending.write_text(json.dumps(state))
assert "session-generation-changed" in scan(env, expected_code=78)
print("desktop generation discovery, self/tmp exclusion, active-lock and generation-change tests passed")
