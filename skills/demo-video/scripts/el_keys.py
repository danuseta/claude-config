"""ElevenLabs keys for tts.py and align.py, rotated through the kit's el-rotate.cjs (the keys live in DOCK).

A request runs with the key `el-rotate.cjs get` gives. When ElevenLabs answers 401, 402, 403 or 429, or a body that names a
quota, rate limit or missing credits, the key is parked (`el-rotate.cjs park`), the next one is taken and the request runs
again, until a key works or every key is parked. Only then KeysParked is raised, naming each key tried and why
(for example `suryo: quota_exceeded`). Another HTTP error is raised as it is and parks nothing.

Without el-rotate.cjs (no kit on this machine) the key is ELEVENLABS_API_KEY and nothing rotates.
The kit folder is DEMO_KIT_DIR, else $CLAUDE_CONFIG_DIR/kit, else ~/.claude/kit. Keys are never printed.
"""
import json
import os
import re
import subprocess
import urllib.error
import urllib.request

API_BASE = os.environ.get("ELEVENLABS_API_BASE", "https://api.elevenlabs.io/v1").rstrip("/")
SPENT_STATUS = {401, 402, 403, 429}
SPENT_WORDS = ("quota", "rate limit", "too many requests", "insufficient", "credits")
MAX_TURNS = 50


class KeysParked(Exception):
    """Every ElevenLabs key is parked; `tried` lists (name, reason) for each key this run parked."""

    def __init__(self, tried, detail=""):
        self.tried = list(tried)
        names = ", ".join(f"{name}: {reason}" for name, reason in self.tried) or "none in this run"
        super().__init__(f"all ElevenLabs keys are parked ({detail or 'no usable key'}); tried {names}")


def kit_dir():
    explicit = os.environ.get("DEMO_KIT_DIR")
    if explicit:
        return explicit
    base = os.environ.get("CLAUDE_CONFIG_DIR") or os.path.join(os.path.expanduser("~"), ".claude")
    return os.path.join(base, "kit")


def rotator():
    """The command that runs el-rotate.cjs, or None when the kit has none."""
    kit = kit_dir()
    script = os.path.join(kit, "el-rotate.cjs")
    if not os.path.isfile(script):
        return None
    kit_node = os.path.join(kit, "bin", "kit-node")
    if os.name != "nt" and os.path.isfile(kit_node):
        return ["bash", kit_node, "el-rotate.cjs"]
    return [os.environ.get("DEMO_NODE", "node"), script]


def spent(status, body):
    text = (body or "").lower()
    return status in SPENT_STATUS or any(word in text for word in SPENT_WORDS)


def reason_of(status, body):
    """ElevenLabs' own code (quota_exceeded, invalid_api_key, ...), else the HTTP status."""
    try:
        detail = json.loads(body).get("detail")
        if isinstance(detail, dict):
            code = detail.get("status") or detail.get("code") or detail.get("type")
            if code:
                return str(code)[:60]
        if isinstance(detail, str) and detail:
            return detail[:60]
    except (ValueError, AttributeError):
        pass
    return f"HTTP {status}"


class Keys:
    def __init__(self, run=None, env_key=None):
        self.command = rotator() if run is None else None
        self._run = run
        self.env_key = os.environ.get("ELEVENLABS_API_KEY") if env_key is None else env_key
        self.key = None
        self.tried = []

    @property
    def rotates(self):
        return self._run is not None or self.command is not None

    def rotate(self, op):
        if self._run is not None:
            return self._run(op)
        done = subprocess.run([*self.command, op], capture_output=True, text=True)
        return done.returncode, done.stdout.strip(), done.stderr.strip()

    def current(self):
        if self.key:
            return self.key
        if not self.rotates:
            if not self.env_key:
                raise KeysParked(self.tried, "ELEVENLABS_API_KEY is not set and the kit has no el-rotate.cjs")
            self.key = self.env_key
            return self.key
        code, out, err = self.rotate("get")
        if code != 0 or not out:
            raise KeysParked(self.tried, err or "el-rotate get gave no key")
        self.key = out
        return self.key

    def call(self, send):
        """send(key) returns the response bytes or raises urllib.error.HTTPError; rotation as the module says."""
        for _ in range(MAX_TURNS):
            key = self.current()
            try:
                return send(key)
            except urllib.error.HTTPError as error:
                body = error.read().decode("utf-8", "replace") if hasattr(error, "read") else ""
                if not spent(error.code, body) or not self.rotates:
                    raise
                reason = reason_of(error.code, body)
                code, out, err = self.rotate("park")
                match = re.search(r'parked "([^"]+)"', out)
                self.tried.append((match.group(1) if match else "unnamed", reason))
                self.key = None
                if code != 0:
                    raise KeysParked(self.tried, err or "el-rotate park failed")
        raise KeysParked(self.tried, f"more than {MAX_TURNS} keys tried")


def post(path, body, headers, timeout, keys):
    """POST to the ElevenLabs API with rotation; the response bytes."""
    def send(key):
        request = urllib.request.Request(f"{API_BASE}{path}", data=body, headers={**headers, "xi-api-key": key}, method="POST")
        with urllib.request.urlopen(request, timeout=timeout) as response:
            return response.read()
    return keys.call(send)
