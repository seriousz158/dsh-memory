#!/usr/bin/env python3
"""Filter a DSH session log into a compact, redacted markdown transcript.

Usage:
  python3 filter_session.py <session.jsonl.zstd> [> transcript.md]
  zstd -dc <session.jsonl.zstd> | python3 filter_session.py -
"""
import json
import os
import re
import shutil
import subprocess
import sys

ARG_MAX = 200
RESULT_MAX = 400
MESSAGE_MAX = 2000
METADATA_MAX = 400
REDACTION = "[REDACTED]"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
ZSTD_FALLBACKS = ("/opt/homebrew/bin/zstd", "/usr/local/bin/zstd")

BEARER_RE = re.compile(r"(?i)\bbearer[ \t]+[A-Za-z0-9._~+/=-]{3,}")
SK_KEY_RE = re.compile(r"\bsk-[A-Za-z0-9_-]{3,}", re.IGNORECASE)
GITHUB_KEY_RE = re.compile(
    r"\b(?:gh[pousr]_[A-Za-z0-9]{4,}|github_pat_[A-Za-z0-9_]{20,})\b",
    re.IGNORECASE,
)
AWS_ACCESS_KEY_RE = re.compile(
    r"\b(?:A3T|AKIA|ASIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASCA)[A-Z0-9]{16}\b"
)
QUERY_SECRET_RE = re.compile(
    r"(?i)([?&](?:access_token|api[_-]?key|auth|password|passwd|pwd|token)=)([^&#\s\"']+)"
)
HOME_PREFIX_RE = re.compile(r"(?<![A-Za-z0-9_])(?:/Users/[^/\s]+|/home/[^/\s]+|/root)(?=/|\b)")
SENSITIVE_FIELD_RE = re.compile(
    r"(?i)^(?:access[_-]?token|api[_-]?key|authorization|auth|password|passwd|pwd|secret|token)$"
)


def redact_text(value: str) -> str:
    """Redact common credential shapes and normalize absolute home prefixes."""
    value = HOME_PREFIX_RE.sub("$HOME", value)
    value = QUERY_SECRET_RE.sub(lambda match: f"{match.group(1)}{REDACTION}", value)
    value = BEARER_RE.sub(f"Bearer {REDACTION}", value)
    value = SK_KEY_RE.sub(REDACTION, value)
    value = GITHUB_KEY_RE.sub(REDACTION, value)
    value = AWS_ACCESS_KEY_RE.sub(REDACTION, value)
    return value


def redact_value(value, field_name=None):
    """Recursively redact parsed tool data before any serialization/truncation."""
    if field_name is not None and SENSITIVE_FIELD_RE.match(str(field_name)):
        return REDACTION
    if isinstance(value, str):
        return redact_text(value)
    if isinstance(value, dict):
        return {key: redact_value(item, key) for key, item in value.items()}
    if isinstance(value, list):
        return [redact_value(item) for item in value]
    return value


def truncate(value: str, limit: int) -> str:
    value = value.strip()
    if len(value) <= limit:
        return value
    return value[:limit] + f" …[truncated {len(value) - limit} chars]"


def summarize_arguments(raw) -> str:
    try:
        parsed = json.loads(raw) if isinstance(raw, str) else raw
    except Exception:
        return truncate(redact_text(str(raw)), ARG_MAX)
    serialized = json.dumps(redact_value(parsed), ensure_ascii=False)
    return truncate(serialized, ARG_MAX)


def is_injected(text: str) -> bool:
    stripped = text.strip()
    return stripped.startswith("<system-reminder>") or stripped.startswith("Current runtime context.")


def text_blocks(node) -> list:
    found = []
    if not isinstance(node, dict):
        return found
    content = node.get("content", [])
    if not isinstance(content, list):
        return found
    for block in content:
        if isinstance(block, dict) and block.get("type") == "text" and block.get("text"):
            text = str(block["text"])
            if not is_injected(text):
                found.append(redact_text(text))
    return found


def result_texts(node):
    """Yield text blocks from arbitrarily nested tool result containers."""
    if isinstance(node, dict):
        if node.get("type") == "text" and node.get("text") is not None:
            yield redact_text(str(node["text"]))
            return
        for value in node.values():
            yield from result_texts(value)
    elif isinstance(node, list):
        for value in node:
            yield from result_texts(value)


def safe_metadata(value) -> str:
    return truncate(redact_text(str(value)), METADATA_MAX)


def render(events):
    out = []
    header = next(
        (event for event in events if isinstance(event, dict) and event.get("type") == "session"),
        {},
    )
    title = None
    for event in events:
        if not isinstance(event, dict) or event.get("type") != "session/title":
            continue
        data = event.get("data", {})
        if isinstance(data, dict):
            message = data.get("message", {})
            title = data.get("title") or (message.get("title") if isinstance(message, dict) else None)
    out.append(f"# Session {safe_metadata(header.get('id', '?'))}")
    out.append(f"- cwd: {safe_metadata(header.get('cwd', '?'))}")
    out.append(f"- preset: {safe_metadata(header.get('agentPreset', '?'))}")
    if title:
        out.append(f"- title: {safe_metadata(title)}")
    out.append("")

    turn = None
    for event in events:
        if not isinstance(event, dict):
            continue
        event_type = event.get("type")
        data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
        if event_type == "turn/start":
            turn = data.get("turn")
        elif event_type == "user/message":
            texts = text_blocks(data)
            if texts:
                out.extend([f"## Turn {turn or '?'} · user", truncate("\n".join(texts), MESSAGE_MAX), ""])
        elif event_type == "assistant/message":
            texts = text_blocks(data.get("message", {}))
            if texts:
                out.extend([f"## Turn {turn or '?'} · assistant", truncate("\n".join(texts), MESSAGE_MAX), ""])
        elif event_type == "tool/call":
            name = safe_metadata(data.get("name", "?"))
            out.append(f"- tool: {name}({summarize_arguments(data.get('arguments', ''))})")
        elif event_type == "tool/result":
            results = list(result_texts(data.get("message", {})))
            if results:
                out.append(f"- result: {truncate(' '.join(results), RESULT_MAX)}")
    return "\n".join(out)


class ZstdUnavailable(RuntimeError):
    """The input is a zstd frame but no usable decoder is available."""


def resolve_zstd() -> str:
    """Resolve zstd without silently ignoring an explicit operator override."""
    if "DPSK_ZSTD" in os.environ:
        candidate = os.environ.get("DPSK_ZSTD", "")
        if not candidate or not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            raise ZstdUnavailable("DPSK_ZSTD is set but is not an executable zstd binary")
        return candidate

    candidate = shutil.which("zstd")
    if candidate:
        return candidate
    for candidate in ZSTD_FALLBACKS:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise ZstdUnavailable("no executable zstd binary was found")


def read_session_bytes(path: str) -> bytes:
    """Read plain JSONL or decode a file whose bytes identify a zstd frame."""
    if path == "-":
        return sys.stdin.buffer.read()

    with open(path, "rb") as handle:
        prefix = handle.read(4)
        if prefix != ZSTD_MAGIC:
            handle.seek(0)
            return handle.read()

    zstd = resolve_zstd()
    try:
        return subprocess.run(
            [zstd, "-dc", path],
            capture_output=True,
            check=True,
        ).stdout
    except (OSError, subprocess.CalledProcessError) as exc:
        raise ZstdUnavailable("zstd could not decode the session input") from exc


def main():
    if len(sys.argv) < 2:
        print(__doc__)
        sys.exit(2)
    path = sys.argv[1]
    try:
        raw = read_session_bytes(path)
    except ZstdUnavailable as exc:
        print(f"zstd-unavailable: {exc}", file=sys.stderr)
        sys.exit(1)
    events = []
    for line in raw.decode("utf-8", errors="replace").splitlines():
        if not line.strip():
            continue
        try:
            events.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    print(render(events))


if __name__ == "__main__":
    main()
