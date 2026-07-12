#!/usr/bin/env python3
"""Self-contained pack_audit fixture for CI.

The production `spec_pack_audit` MCP tool shells out to the external
hermes-spec-pack-prep `pack_audit.py`, which is not vendored in this repo. This
stub implements the SAME command-line contract (`--pack-root`, `--upload-dir`,
`--max-mb`) and emits the same JSON shape, so CI can exercise the TypeScript
wrapper (arg passing, JSON parsing, verdict/token surfacing, error handling and
the INVARIANT#23 evidence integration) without the private skill installed.

It performs real — if minimal — checks against the pack rather than rubber-
stamping: declared pack.yaml counts must match the actual ingest jsonl line
counts, every upload file must be under the size limit, and payload bodies must
clear a small length gate. The completion_token is a content hash so it changes
when the pack changes. This is deliberately NOT a reimplementation of the real
auditor's domain logic — it verifies the wrapper contract only.
"""
import argparse
import hashlib
import json
import os
import re
import sys


def count_lines(path):
    if not os.path.isfile(path):
        return 0
    n = 0
    with open(path, "r", encoding="utf-8") as fh:
        for line in fh:
            if line.strip():
                n += 1
    return n


def read_declared_counts(pack_yaml):
    """Tiny YAML reader for the `counts:` block (no external deps)."""
    counts = {}
    if not os.path.isfile(pack_yaml):
        return counts
    in_counts = False
    with open(pack_yaml, "r", encoding="utf-8") as fh:
        for raw in fh:
            if re.match(r"^counts:\s*$", raw):
                in_counts = True
                continue
            if in_counts:
                m = re.match(r"^\s+([A-Za-z_]+):\s*(\d+)\s*$", raw)
                if m:
                    counts[m.group(1)] = int(m.group(2))
                elif raw.strip() and not raw.startswith(" "):
                    break
    return counts


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pack-root", required=True)
    ap.add_argument("--upload-dir", default=None)
    ap.add_argument("--max-mb", type=float, default=5.0)
    args = ap.parse_args()

    blockers = []
    pack_root = args.pack_root
    ingest = os.path.join(pack_root, "ingest")

    if not os.path.isdir(pack_root):
        print(json.dumps({"verdict": "ERROR", "blockers": [f"pack_root not found: {pack_root}"]}))
        return 0

    declared = read_declared_counts(os.path.join(pack_root, "pack.yaml"))
    payloads = count_lines(os.path.join(ingest, "opencrab_payloads.jsonl"))
    chunks = count_lines(os.path.join(ingest, "chunks.jsonl"))
    documents = count_lines(os.path.join(ingest, "documents.jsonl"))

    if declared.get("chunks") is not None and declared["chunks"] != chunks:
        blockers.append(f"declared chunks {declared['chunks']} != actual {chunks}")
    if declared.get("specifications") is not None and declared["specifications"] != documents:
        blockers.append(f"declared specifications {declared['specifications']} != actual documents {documents}")
    if payloads == 0:
        blockers.append("ingest/opencrab_payloads.jsonl is empty or missing")

    # Body-quality gate: average payload content length must clear a floor.
    total_len, rows = 0, 0
    pj = os.path.join(ingest, "opencrab_payloads.jsonl")
    if os.path.isfile(pj):
        with open(pj, "r", encoding="utf-8") as fh:
            for line in fh:
                line = line.strip()
                if not line:
                    continue
                try:
                    obj = json.loads(line)
                except json.JSONDecodeError:
                    blockers.append("malformed payload jsonl line")
                    continue
                total_len += len(str(obj.get("content", "")))
                rows += 1
    avg_body = (total_len / rows) if rows else 0
    if rows and avg_body < 200:
        blockers.append(f"average payload body {avg_body:.0f} chars below quality floor (metadata-only?)")

    # Upload size guard.
    upload_files = []
    if args.upload_dir and os.path.isdir(args.upload_dir):
        limit = args.max_mb * 1024 * 1024
        for name in sorted(os.listdir(args.upload_dir)):
            fp = os.path.join(args.upload_dir, name)
            if os.path.isfile(fp):
                size = os.path.getsize(fp)
                upload_files.append({"name": name, "mb": round(size / 1024 / 1024, 4)})
                if size > limit:
                    blockers.append(f"upload file {name} exceeds {args.max_mb}MB")

    verdict = "PASS" if not blockers else "FAIL"
    result = {
        "verdict": verdict,
        "blockers": blockers,
        "declared": declared,
        "actual": {"payloads": payloads, "chunks": chunks, "documents": documents},
        "payload_stats": {"rows": rows, "avg_body_chars": round(avg_body, 1)},
        "upload_files": upload_files,
        "completion_token": None,
    }
    if verdict == "PASS":
        h = hashlib.sha256()
        for rel in ("pack.yaml", "ingest/opencrab_payloads.jsonl", "ingest/chunks.jsonl", "ingest/documents.jsonl"):
            fp = os.path.join(pack_root, rel)
            if os.path.isfile(fp):
                with open(fp, "rb") as fh:
                    h.update(fh.read())
        result["completion_token"] = h.hexdigest()[:24]

    print(json.dumps(result))
    return 0


if __name__ == "__main__":
    sys.exit(main())
