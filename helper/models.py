#!/usr/bin/env python3
# SPDX-License-Identifier: MIT
"""Skeet speech models: list, download (with checksum), delete.

Standard library only, so it runs before the speech engine is installed.
The settings window drives it and reads its output line by line:

  models.py list                 -> one JSON object per model
  models.py download ID          -> "PROGRESS <bytes> <total>" lines, then
                                    "DONE" or "ERROR: <message>"
  models.py delete ID

A download goes to a .part file, is checked against the SHA-256 below,
unpacked into a temporary folder and only then moved into place, so a
cancelled (SIGTERM) or failed download never leaves a half model behind.
"""

import hashlib
import json
import os
import shutil
import signal
import sys
import tarfile
import urllib.request

RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download/asr-models"
MODELS = {
    "parakeet-v2-en": {
        "name": "English",
        "description": "NVIDIA Parakeet TDT 0.6B v2. Most accurate for English.",
        "dir": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8",
        "url": f"{RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v2-int8.tar.bz2",
        "bytes": 482468385,
        "sha256": "157c157bc51155e03e37d2466522a3a737dd9c72bb25f36eb18912964161e1ad",
        "licence": "CC-BY-4.0",
    },
    "parakeet-v3": {
        "name": "Multilingual",
        "description": "NVIDIA Parakeet TDT 0.6B v3. 25 European languages, detected automatically.",
        "dir": "sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        "url": f"{RELEASES}/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8.tar.bz2",
        "bytes": 487170055,
        "sha256": "5793d0fd397c5778d2cf2126994d58e9d56b1be7c04d13c7a15bb1b4eafb16bf",
        "licence": "CC-BY-4.0",
    },
}
REQUIRED = ("encoder.int8.onnx", "decoder.int8.onnx", "joiner.int8.onnx", "tokens.txt")

DATA_DIR = os.path.join(
    os.environ.get("XDG_DATA_HOME") or os.path.expanduser("~/.local/share"), "skeet")
MODELS_DIR = os.path.join(DATA_DIR, "models")


def installed(model):
    d = os.path.join(MODELS_DIR, model["dir"])
    return all(os.path.isfile(os.path.join(d, f)) for f in REQUIRED)


def cmd_list():
    for mid, m in MODELS.items():
        print(json.dumps({"id": mid, "name": m["name"], "description": m["description"],
                          "bytes": m["bytes"], "licence": m["licence"],
                          "installed": installed(m)}), flush=True)


def cmd_download(mid):
    m = MODELS[mid]
    os.makedirs(MODELS_DIR, exist_ok=True)
    part = os.path.join(MODELS_DIR, f".{mid}.tar.bz2.part")
    tmp = os.path.join(MODELS_DIR, f".{mid}.unpacking")
    final = os.path.join(MODELS_DIR, m["dir"])

    def cleanup(*_):
        for p in (part,):
            if os.path.exists(p):
                os.remove(p)
        shutil.rmtree(tmp, ignore_errors=True)
        if _:
            print("ERROR: cancelled", flush=True)
            sys.exit(1)

    signal.signal(signal.SIGTERM, cleanup)
    signal.signal(signal.SIGINT, cleanup)
    try:
        sha = hashlib.sha256()
        done = 0
        req = urllib.request.Request(m["url"], headers={"User-Agent": "skeet"})
        with urllib.request.urlopen(req, timeout=30) as r, open(part, "wb") as out:
            total = int(r.headers.get("Content-Length") or m["bytes"])
            last = -1
            while chunk := r.read(1 << 20):
                out.write(chunk)
                sha.update(chunk)
                done += len(chunk)
                pct = done * 100 // max(total, 1)
                if pct != last:
                    last = pct
                    print(f"PROGRESS {done} {total}", flush=True)
        if sha.hexdigest() != m["sha256"]:
            raise RuntimeError("the download is corrupt (checksum mismatch); try again")
        print("UNPACKING", flush=True)
        shutil.rmtree(tmp, ignore_errors=True)
        os.makedirs(tmp)
        with tarfile.open(part, "r:bz2") as t:
            try:
                t.extractall(tmp, filter="data")
            except TypeError:  # Python without extraction filters
                t.extractall(tmp)
        src = os.path.join(tmp, m["dir"])
        if not all(os.path.isfile(os.path.join(src, f)) for f in REQUIRED):
            raise RuntimeError("the archive doesn't contain the expected model files")
        shutil.rmtree(final, ignore_errors=True)
        os.rename(src, final)
    except Exception as e:
        cleanup()
        msg = getattr(e, "reason", None) or e
        print(f"ERROR: {msg}", flush=True)
        return 1
    cleanup()
    print("DONE", flush=True)
    return 0


def cmd_delete(mid):
    shutil.rmtree(os.path.join(MODELS_DIR, MODELS[mid]["dir"]), ignore_errors=True)
    print("DONE", flush=True)
    return 0


def main():
    if len(sys.argv) < 2 or sys.argv[1] not in ("list", "download", "delete"):
        print(__doc__, file=sys.stderr)
        return 2
    if sys.argv[1] == "list":
        return cmd_list()
    if len(sys.argv) < 3 or sys.argv[2] not in MODELS:
        print(f"ERROR: unknown model; choose one of {', '.join(MODELS)}", flush=True)
        return 2
    return (cmd_download if sys.argv[1] == "download" else cmd_delete)(sys.argv[2])


if __name__ == "__main__":
    sys.exit(main() or 0)
