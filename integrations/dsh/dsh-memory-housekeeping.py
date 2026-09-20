#!/usr/bin/env python3
"""宿主侧记忆内务处理（确定性、幂等、最小字节改动）。

在 staging 校验之前由 bin/dsh-memory-sync 调用。所有改动都发生在事务内，
与模型产出一起接受同一套 fail-closed 校验后再提交——不绕过单写者契约。

两件事：

1) legacy 补 front matter
   对 handbook/ rollouts/ archive/ 下没有 schema v1 front matter 的旧 Markdown，
   补上最小字段。算法与插件侧 .dsh/profiles/dsh-memory/lib/legacy-migration.js
   **逐字对齐**，因此补出来的 id 与索引器运行时合成的 id 一致：
       id        = "legacy-" + sha256(相对路径)[:16]
       created_at/updated_at = 文件 mtime 的日期（本机时区）
   只补最小字段，不推断 type/status/confidence（那是提炼阶段的职责）。

2) 原地归档（方案 a）
   把满足条件的条目 status 置为 archived。**文件不移动**——因为校验器要求
   source_rollouts 以 "rollouts/" 开头，搬进 archive/ 会让所有溯源引用悬空。
   规则（保守、可解释、永不删除；git 保留全部历史）：
     R1: status 已是 superseded，且 updated_at 早于 N 天 → archived
     R2: updated_at 早于 M 天，且没有任何入边引用（source_rollouts/supersedes/
         conflicts_with 都不指向它）→ archived
   已处于 archived 的条目跳过（幂等）。

用法：
    dsh-memory-housekeeping.py --staging <dir>
        [--legacy-age-days N]      默认 0（全部迁移）
        [--superseded-grace-days]  默认 30
        [--stale-days]             默认 180
        [--no-legacy] [--no-archive]
stdout 输出 JSON 报告。
"""

import argparse
import datetime
import hashlib
import json
import os
import re
import sys

PAYLOAD_DIRS = ("handbook", "rollouts", "archive")
FM_RE = re.compile(r"^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)")
REF_KEYS = ("source_rollouts", "supersedes", "conflicts_with")


def legacy_id(rel_path: str) -> str:
    return "legacy-" + hashlib.sha256(rel_path.encode("utf-8")).hexdigest()[:16]


def legacy_front_matter(rel_path: str, mtime: float) -> str:
    date = datetime.datetime.fromtimestamp(mtime).strftime("%Y-%m-%d")
    return (
        "---\n"
        "schema_version: 1\n"
        f"id: {legacy_id(rel_path)}\n"
        f"created_at: {date}\n"
        f"updated_at: {date}\n"
        "---\n"
    )


def parse_ids_and_refs(paths):
    """收集每个文件的 id，以及全部出边引用（用于判断"有无入边引用"）。"""
    ids = {}          # id -> rel_path
    refs = set()      # 被引用到的 id 或路径
    for rel in paths:
        try:
            text = open(rel, encoding="utf-8", errors="strict").read()
        except Exception:
            continue
        m = FM_RE.match(text)
        if not m:
            continue
        block = m.group(1)
        mid = re.search(r"^id:\s*(.+)$", block, re.M)
        if mid:
            ids[mid.group(1).strip()] = rel
        for key in REF_KEYS:
            km = re.search(r"^%s:[ \t]*(.*)$" % key, block, re.M)
            if not km:
                continue
            inline = km.group(1).strip()
            if inline and inline not in ("[]", "{}"):
                refs.add(inline.strip().strip('"\''))
            # 块列表项
            rest = block[km.end():]
            for line in rest.splitlines():
                if re.match(r"^[ \t]*-", line):
                    refs.add(line.split("-", 1)[1].strip().strip('"\''))
                elif line.strip() and not line.startswith((" ", "\t")):
                    break
    return ids, refs


def set_status(text, new_status):
    """只改 front matter 里的 status 行；不存在则插入到结束分隔符之前。
    返回 (新文本, 是否改动)。"""
    m = FM_RE.match(text)
    if not m:
        return text, False
    block = m.group(1)
    if re.search(r"^status:[ \t]*(.+)$", block, re.M):
        new_block = re.sub(r"^status:\s*.+$", "status: %s" % new_status, block, count=1, flags=re.M)
    else:
        new_block = block + "\nstatus: %s" % new_status
    if new_block == block:
        return text, False
    start, end = m.span(1)
    return text[:start] + new_block + text[end:], True


def days_since(date_str):
    try:
        d = datetime.datetime.strptime(date_str, "%Y-%m-%d").date()
    except Exception:
        return None
    return (datetime.date.today() - d).days


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--staging", required=True)
    ap.add_argument("--superseded-grace-days", type=int, default=30)
    ap.add_argument("--stale-days", type=int, default=180)
    ap.add_argument("--no-legacy", action="store_true")
    ap.add_argument("--no-archive", action="store_true")
    args = ap.parse_args()

    root = args.staging
    files = []
    for d in PAYLOAD_DIRS:
        base = os.path.join(root, d)
        for dp, _dn, fn in os.walk(base):
            for f in fn:
                if f.endswith(".md"):
                    files.append(os.path.join(dp, f))

    report = {"legacy_migrated": [], "archived": [], "errors": []}

    # ---------- 1) legacy 补 front matter ----------
    if not args.no_legacy:
        for path in files:
            rel = os.path.relpath(path, root)
            try:
                text = open(path, encoding="utf-8").read()
            except Exception as e:
                report["errors"].append("%s: %s" % (rel, e))
                continue
            if FM_RE.match(text):
                continue
            try:
                mt = os.path.getmtime(path)
                open(path, "w", encoding="utf-8").write(legacy_front_matter(rel, mt) + text)
                report["legacy_migrated"].append(rel)
            except Exception as e:
                report["errors"].append("%s: %s" % (rel, e))

    # ---------- 2) 原地归档 ----------
    if not args.no_archive:
        ids, refs = parse_ids_and_refs(files)
        for path in files:
            rel = os.path.relpath(path, root)
            try:
                text = open(path, encoding="utf-8").read()
            except Exception as e:
                report["errors"].append("%s: %s" % (rel, e))
                continue
            m = FM_RE.match(text)
            if not m:
                continue
            block = m.group(1)

            def get(k):
                mm = re.search(r"^%s:[ \t]*(.+)$" % k, block, re.M)
                return mm.group(1).strip() if mm else None

            status = get("status")
            if status == "archived":
                continue
            rid = get("id")
            updated = get("updated_at")
            age = days_since(updated) if updated else None

            reason = None
            if status == "superseded" and age is not None and age >= args.superseded_grace_days:
                reason = "R1 superseded %dd" % age
            elif age is not None and age >= args.stale_days:
                # 入边引用有两种写法：source_rollouts 用**路径**（rollouts/x.md，
                # 校验器强制此前缀），supersedes/conflicts_with 用 **id**。
                # 两者都要查，否则被引用的条目会被误判为孤儿而归档。
                referenced = bool((rid and rid in refs) or (rel in refs))
                if not referenced:
                    reason = "R2 stale %dd, unreferenced" % age
            if reason is None:
                continue

            new_text, changed = set_status(text, "archived")
            if changed:
                try:
                    open(path, "w", encoding="utf-8").write(new_text)
                    report["archived"].append({"path": rel, "reason": reason})
                except Exception as e:
                    report["errors"].append("%s: %s" % (rel, e))

    print(json.dumps(report, ensure_ascii=False))
    return 0


if __name__ == "__main__":
    sys.exit(main())
