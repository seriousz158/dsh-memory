"""Zero-provider V2/V3 selection, idle, pending-generation and watermark tests."""
import hashlib
import json
import os
from pathlib import Path
import subprocess
import tempfile
import time

ROOT = Path(__file__).resolve().parents[1]
NOW = time.time()


def fixture():
    base = Path(tempfile.mkdtemp(prefix="dsh-v3-scan-"))
    home, memory = base / "dsh", base / "memory"
    env = {**os.environ, "HOME": str(base), "DSH_HOME": str(home), "DSH_MEMORY_ROOT": str(memory), "DSH_BIN": "/does-not-exist-no-provider"}
    subprocess.run([str(ROOT / "integrations/dsh/dsh-memory-init")], env=env, check=True, capture_output=True)
    marker = memory / ".last-sync"
    marker.touch()
    os.utime(marker, (NOW - 20000, NOW - 20000))
    return home, memory, env


def log(home, name, filename, age=7200):
    path = home / "sessions" / name / filename
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("synthetic scan-only fixture")
    os.utime(path, (NOW - age, NOW - age))
    return path


def scan(memory, env, expected_code=0):
    marker = memory / ".last-sync"
    before = marker.stat().st_mtime_ns
    pending = memory / ".sync/pending-candidates.json"
    saved = pending.read_bytes() if pending.exists() else None
    result = subprocess.run(["zsh", str(ROOT / "integrations/dsh/dsh-memory-sync"), "--scan-only", "--json"], env=env, text=True, capture_output=True)
    assert result.returncode == expected_code, (result.returncode, result.stderr)
    assert marker.stat().st_mtime_ns == before
    assert (pending.read_bytes() if pending.exists() else None) == saved
    return json.loads(result.stdout) if expected_code == 0 else result.stderr


home, memory, env = fixture()
old = log(home, "migrated", "session.jsonl.zstd")
new = log(home, "migrated", "session.v3.jsonl.zstd")
v2 = log(home, "legacy", "session.jsonl.zstd")
v3 = log(home, "new", "session.v3.jsonl.zstd")
log(home, "busy", "session.jsonl.zstd")
log(home, "busy", "session.v3.jsonl.zstd", age=10)
value = scan(memory, env)
assert {x["path"] for x in value["candidates"]} == {str(new), str(v2), str(v3)}, value
assert value["candidateSessions"] == 3
limited = scan(memory, {**env, "DSH_MEMORY_MAX_CANDIDATE_SESSIONS": "1"})
assert limited["candidateSessions"] == 1 and limited["truncated"]

pending = memory / ".sync/pending-candidates.json"
pending.parent.mkdir(exist_ok=True)
state = {"schema_version": 2, "entries": {str(old): {"digest": hashlib.sha256(old.read_bytes()).hexdigest(), "next_chunk": 2, "chunk_total": 3, "complete": False}}}
pending.write_text(json.dumps(state))
assert "session-generation-changed" in scan(memory, env, expected_code=78)
# Completed old generations do not block V3; their cursor is never reused.
state["entries"][str(old)]["complete"] = True
pending.write_text(json.dumps(state))
assert str(new) in {x["path"] for x in scan(memory, env)["candidates"]}
# Existing V3 partial chunks remain eligible without any cursor mutation.
state["entries"][str(new)] = {"digest": hashlib.sha256(new.read_bytes()).hexdigest(), "next_chunk": 2, "chunk_total": 3, "complete": False}
pending.write_text(json.dumps(state))
assert str(new) in {x["path"] for x in scan(memory, env)["candidates"]}
# Delivered V3 digests are skipped, preserving batch retry idempotency.
state["entries"][str(new)]["complete"] = True
pending.write_text(json.dumps(state))
assert str(new) not in {x["path"] for x in scan(memory, env)["candidates"]}
print("V3 selection, idle exclusion, pending safety, batch cap and unchanged watermark tests passed")
