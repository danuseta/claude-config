#!/usr/bin/env python3
"""Probe the 5h and 7d usage windows of every Claude account (Python standard library only).

Loads <CLAUDE_CONFIG_DIR or ~/.claude>/account-cycle/cycle.py for names() and secret_get(name), sends one
max_tokens=1 request per account and prints a JSON array:
[{name, status, fp, fiveHour: {usedPercentage, resetsAt}|null, sevenDay: {...}|null, error?}].
fp is the first 12 hex of sha256(token), the same value statusline.cjs sends as accountFp.
claude1 uses the CLAUDE_CODE_OAUTH_TOKEN env var. Tokens are never printed and no file is written.
Exit 0 even when accounts fail; exit 2 when cycle.py is missing. ACCOUNT_USAGE_API overrides the API base (tests only).
"""
import argparse
import datetime
import hashlib
import importlib.util
import json
import os
import sys
import urllib.error
import urllib.request

BODY = {
    "model": "claude-haiku-5-5",
    "max_tokens": 1,
    "system": "You are Claude Code, Anthropic's official CLI for Claude.",
    "messages": [{"role": "user", "content": "hi"}],
}
PREFIX = "anthropic-ratelimit-unified-"


def load_cycle():
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    path = os.path.join(base, "account-cycle", "cycle.py")
    if not os.path.isfile(path):
        return None
    spec = importlib.util.spec_from_file_location("account_cycle", path)
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def window(headers, key):
    util = headers.get(PREFIX + key + "-utilization")
    reset = headers.get(PREFIX + key + "-reset")
    if util is None:
        return None
    try:
        pct = round(float(util) * 100, 2)
        at = None
        if reset is not None:
            at = datetime.datetime.fromtimestamp(float(reset), datetime.timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    except (TypeError, ValueError, OverflowError, OSError):
        return None
    return {"usedPercentage": pct, "resetsAt": at}


def fingerprint(token):
    return hashlib.sha256(token.encode("utf-8")).hexdigest()[:12]


def probe(name, token, api):
    row = {"name": name, "status": "error", "fiveHour": None, "sevenDay": None}
    req = urllib.request.Request(
        api.rstrip("/") + "/v1/messages",
        data=json.dumps(BODY).encode("utf-8"),
        method="POST",
        headers={
            "authorization": "Bearer " + token,
            "anthropic-version": "2023-06-01",
            "anthropic-beta": "oauth-2025-04-20",
            "content-type": "application/json",
        },
    )
    headers = None
    try:
        with urllib.request.urlopen(req, timeout=20) as res:
            headers = res.headers
    except urllib.error.HTTPError as e:
        headers = e.headers
        if e.code != 429 and headers.get(PREFIX + "status") is None:
            row["error"] = "HTTP %d" % e.code
    except Exception as e:
        row["error"] = type(e).__name__
    if headers is not None:
        status = headers.get(PREFIX + "status")
        if status:
            row["status"] = status
        row["fiveHour"] = window(headers, "5h")
        row["sevenDay"] = window(headers, "7d")
    return row


def main():
    ap = argparse.ArgumentParser(description="Probe Claude account usage windows.")
    ap.add_argument("--names", help="comma separated account names to probe")
    args = ap.parse_args()
    cycle = load_cycle()
    if cycle is None:
        print(json.dumps({"error": "cycle.py not found"}))
        return 2
    api = os.environ.get("ACCOUNT_USAGE_API") or "https://api.anthropic.com"
    var = getattr(cycle, "VAR", "CLAUDE_CODE_OAUTH_TOKEN")
    names = ["claude1"] + [n for n in cycle.names() if n != "claude1"]
    if args.names:
        want = {n.strip() for n in args.names.split(",") if n.strip()}
        names = [n for n in names if n in want]
    out = []
    for name in names:
        try:
            token = os.environ.get(var) if name == "claude1" else cycle.secret_get(name)
        except Exception:
            token = None
        if not token:
            out.append({"name": name, "status": "no-token", "fiveHour": None, "sevenDay": None})
            continue
        row = probe(name, token.strip(), api)
        row["fp"] = fingerprint(token.strip())
        out.append(row)
    print(json.dumps(out))
    return 0


if __name__ == "__main__":
    sys.exit(main())
