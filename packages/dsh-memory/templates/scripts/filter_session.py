#!/usr/bin/env python3
"""Filter a DSH session log into a compact, redacted markdown transcript.

Usage:
  python3 filter_session.py <session.jsonl.zstd> [> transcript.md]
  zstd -dc <session.jsonl.zstd> | python3 filter_session.py -

Chunked mode (v0.8.4): the transcript is written as fixed-size sanitized
chunks with a provenance header, so the host can stream large sessions to
the model without ever materializing the raw payload:

  python3 filter_session.py <session.jsonl.zstd> \
    --chunk-dir <dir> --chunk-bytes 1048576 \
    --session-digest <sha256> [--max-decompressed-bytes 134217728]

Chunked mode prints one JSON summary line on stdout:
  {"session_id": "...", "chunk_total": N, "transcript_bytes": B}

The decoder is streaming: the decompressed payload is consumed line by line
and never fully materialized in memory; a session whose decompressed stream
exceeds --max-decompressed-bytes fails closed with `decompressed-too-large`.
"""
import json
import os
import re
import shutil
import subprocess
import sys
import tempfile

ARG_MAX = 200
RESULT_MAX = 400
MESSAGE_MAX = 2000
METADATA_MAX = 400
REDACTION = "[REDACTED]"
ZSTD_MAGIC = b"\x28\xb5\x2f\xfd"
ZSTD_FALLBACKS = ("/opt/homebrew/bin/zstd", "/usr/local/bin/zstd")
DEFAULT_MAX_DECOMPRESSED_BYTES = 128 * 1024 * 1024

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


class FilterFailure(RuntimeError):
    """A fail-closed filter error with a stable single-line code."""

    def __init__(self, code, message):
        super().__init__(message)
        self.code = code


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


class StreamingRenderer:
    """Incremental transcript renderer: bounded memory, single decode pass.

    The session header block is emitted when the `session` event appears
    (first line in DSH logs); title and per-turn sections stream out as the
    matching events arrive.
    """

    def __init__(self):
        self.lines = []
        self.header_done = False
        self.session_id = None
        self.title_done = False
        self.turn = None

    def _header(self, header):
        self.lines.append(f"# Session {safe_metadata(header.get('id', '?'))}")
        self.lines.append(f"- cwd: {safe_metadata(header.get('cwd', '?'))}")
        self.lines.append(f"- preset: {safe_metadata(header.get('agentPreset', '?'))}")
        self.lines.append("")

    def feed(self, event):
        if not isinstance(event, dict):
            return
        event_type = event.get("type")
        data = event.get("data", {}) if isinstance(event.get("data"), dict) else {}
        if event_type == "session":
            self.session_id = str(event.get("id") or data.get("id") or "?")
            self._header(event if event.get("id") is not None else data)
            self.header_done = True
        elif event_type == "session/title":
            if self.title_done:
                return
            message = data.get("message", {})
            title = data.get("title") or (message.get("title") if isinstance(message, dict) else None)
            if title:
                if not self.header_done:
                    self._header({})
                    self.header_done = True
                self.lines.insert(3, f"- title: {safe_metadata(title)}")
                self.title_done = True
        elif event_type == "turn/start":
            self.turn = data.get("turn")
        elif event_type == "user/message":
            texts = text_blocks(data)
            if texts:
                self.lines.extend([
                    f"## Turn {self.turn or '?'} · user",
                    truncate("\n".join(texts), MESSAGE_MAX),
                    "",
                ])
        elif event_type == "assistant/message":
            texts = text_blocks(data.get("message", {}))
            if texts:
                self.lines.extend([
                    f"## Turn {self.turn or '?'} · assistant",
                    truncate("\n".join(texts), MESSAGE_MAX),
                    "",
                ])
        elif event_type == "tool/call":
            name = safe_metadata(data.get("name", "?"))
            self.lines.append(f"- tool: {name}({summarize_arguments(data.get('arguments', ''))})")
        elif event_type == "tool/result":
            results = list(result_texts(data.get("message", {})))
            if results:
                self.lines.append(f"- result: {truncate(' '.join(results), RESULT_MAX)}")


def resolve_zstd() -> str:
    """Resolve zstd without silently ignoring an explicit operator override."""
    if "DPSK_ZSTD" in os.environ:
        candidate = os.environ.get("DPSK_ZSTD", "")
        if not candidate or not os.path.isfile(candidate) or not os.access(candidate, os.X_OK):
            raise FilterFailure("zstd-unavailable", "DPSK_ZSTD is set but is not an executable zstd binary")
        return candidate

    candidate = shutil.which("zstd")
    if candidate:
        return candidate
    for candidate in ZSTD_FALLBACKS:
        if os.path.isfile(candidate) and os.access(candidate, os.X_OK):
            return candidate
    raise FilterFailure("zstd-unavailable", "no executable zstd binary was found")


def is_zstd_frame(path: str) -> bool:
    with open(path, "rb") as handle:
        return handle.read(4) == ZSTD_MAGIC


def decoded_lines(path: str, max_decompressed: int):
    """Yield decoded text lines without materializing the whole payload.

    Counts decompressed bytes against `max_decompressed` while streaming and
    fails closed with `decompressed-too-large` when the cap is exceeded.
    """
    def stream(handle):
        consumed = 0
        for raw_line in handle:
            consumed += len(raw_line)
            if consumed > max_decompressed:
                raise FilterFailure(
                    "decompressed-too-large",
                    f"decompressed session exceeds {max_decompressed} bytes",
                )
            yield raw_line.decode("utf-8", errors="replace")

    if path == "-":
        yield from stream(sys.stdin.buffer)
        return
    if not is_zstd_frame(path):
        with open(path, "rb") as handle:
            yield from stream(handle)
        return

    zstd = resolve_zstd()
    try:
        process = subprocess.Popen([zstd, "-dc", "--", path], stdout=subprocess.PIPE)
    except OSError as exc:
        raise FilterFailure("zstd-unavailable", "zstd could not be started") from exc
    try:
        yield from stream(process.stdout)
    finally:
        try:
            process.stdout.close()
        except OSError:
            pass
        if process.poll() is None:
            process.terminate()
        process.wait()


def iter_events(path, max_decompressed):
    for line in decoded_lines(path, max_decompressed):
        if not line.strip():
            continue
        try:
            yield json.loads(line)
        except json.JSONDecodeError:
            continue


def render_streaming(path, max_decompressed):
    renderer = StreamingRenderer()
    for event in iter_events(path, max_decompressed):
        renderer.feed(event)
    if not renderer.header_done:
        renderer.lines.insert(0, "# Session ?")
        renderer.lines.insert(1, "- cwd: ?")
        renderer.lines.insert(2, "- preset: ?")
        renderer.lines.insert(3, "")
    return renderer


def chunk_header(session_id, session_digest, index, total):
    return (
        "<!-- dsh-memory-chunk\n"
        f"session_id: {session_id}\n"
        f"session_digest: {session_digest}\n"
        f"chunk_index: {index}/{total}\n"
        "-->\n"
    )


def write_chunks(transcript_path, chunk_dir, base_name, chunk_bytes, session_id, session_digest):
    """Split the sanitized transcript into headered chunks at line boundaries.

    Returns (chunk_paths, chunk_sizes). Each chunk is at most `chunk_bytes`
    bytes of transcript body plus its header; at least one chunk is written
    even for an empty transcript.
    """
    with open(transcript_path, "rb") as handle:
        sizes = []
        current = 0
        for raw_line in handle:
            if current > 0 and current + len(raw_line) > chunk_bytes:
                sizes.append(current)
                current = len(raw_line)
            else:
                current += len(raw_line)
        sizes.append(current)
    total = len(sizes)

    chunk_paths = []
    with open(transcript_path, "rb") as source:
        for index, body_size in enumerate(sizes, start=1):
            chunk_path = os.path.join(chunk_dir, f"{base_name}.chunk{index:02d}.md")
            header = chunk_header(session_id, session_digest, index, total).encode("utf-8")
            with open(chunk_path, "wb") as target:
                os.chmod(chunk_path, 0o600)
                target.write(header)
                remaining = body_size
                while remaining > 0:
                    block = source.read(min(65536, remaining))
                    if not block:
                        break
                    target.write(block)
                    remaining -= len(block)
            chunk_paths.append(chunk_path)
    return chunk_paths, [os.path.getsize(path) for path in chunk_paths]


def main():
    args = sys.argv[1:]
    chunk_dir = None
    chunk_bytes = 0
    session_digest = ""
    max_decompressed = DEFAULT_MAX_DECOMPRESSED_BYTES
    positional = []
    index = 0
    while index < len(args):
        arg = args[index]
        if arg == "--chunk-dir":
            index += 1
            chunk_dir = args[index] if index < len(args) else None
        elif arg == "--chunk-bytes":
            index += 1
            chunk_bytes = int(args[index]) if index < len(args) else 0
        elif arg == "--session-digest":
            index += 1
            session_digest = args[index] if index < len(args) else ""
        elif arg == "--max-decompressed-bytes":
            index += 1
            max_decompressed = int(args[index]) if index < len(args) else DEFAULT_MAX_DECOMPRESSED_BYTES
        else:
            positional.append(arg)
        index += 1

    if not positional:
        print(__doc__)
        sys.exit(2)
    path = positional[0]
    if chunk_dir is not None:
        if chunk_bytes <= 0:
            print("chunk-bytes-required: --chunk-dir requires a positive --chunk-bytes", file=sys.stderr)
            sys.exit(1)
        if not re.fullmatch(r"[0-9a-f]{64}", session_digest or ""):
            print("session-digest-required: chunked mode needs the raw session sha256", file=sys.stderr)
            sys.exit(1)

    try:
        renderer = render_streaming(path, max_decompressed)
    except FilterFailure as exc:
        print(f"{exc.code}: {exc}", file=sys.stderr)
        sys.exit(1)

    if chunk_dir is None:
        print("\n".join(renderer.lines))
        return

    os.makedirs(chunk_dir, mode=0o700, exist_ok=True)
    fd, transcript_path = tempfile.mkstemp(prefix=".transcript.", dir=chunk_dir)
    total_bytes = 0
    try:
        with os.fdopen(fd, "wb") as handle:
            for line in renderer.lines:
                encoded = line.encode("utf-8")
                handle.write(encoded)
                if not encoded.endswith(b"\n"):
                    handle.write(b"\n")
                    total_bytes += len(encoded) + 1
                else:
                    total_bytes += len(encoded)
        os.chmod(transcript_path, 0o600)
        base_name = os.path.basename(chunk_dir.rstrip("/"))
        chunk_paths, chunk_sizes = write_chunks(
            transcript_path, chunk_dir, base_name, chunk_bytes,
            renderer.session_id or "?", session_digest,
        )
    finally:
        try:
            os.unlink(transcript_path)
        except FileNotFoundError:
            pass
    print(json.dumps({
        "session_id": renderer.session_id or "?",
        "chunk_total": len(chunk_paths),
        "chunk_paths": chunk_paths,
        "chunk_sizes": chunk_sizes,
        "transcript_bytes": total_bytes,
    }, separators=(",", ":")))


if __name__ == "__main__":
    main()
