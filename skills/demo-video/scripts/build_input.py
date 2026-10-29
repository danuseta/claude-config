"""Assemble the Remotion input (src/demo.json) from the scenario, the recording cues and the word timings.

Usage: python build_input.py <scenario.json> <cues.json> <words.json> <recording.mp4> <out demo.json>

Timeline (seconds, recording clock = cues.json t0):
  body = [bodyStart, bodyEnd]   demo footage kept, everything outside is trimmed
  narration before bodyStart plays over the intro, after bodyEnd over the outro
  composition: intro [0, intro.dur) -> body -> outro, hard cuts (the intro scale-up is the transition)

Notes (callout boxes) come from cues.json "notes" logged by record.cjs (getBoundingClientRect).
When a recording has none, the pink outline baked into the frames is detected instead (detect_boxes.py),
and the note texts are taken from the scenario highlights in order.
"""
import json
import math
import os
import subprocess
import sys

FPS = 30
MIN_INTRO = 3.5
MIN_OUTRO = 3.0
INTRO_LEAD = 0.5
OUTRO_TAIL = 0.8
EDGE_SAFETY = 0.1
EXIT = 0.6

scenario_path, cues_path, words_path, video_path, out_path = sys.argv[1:6]
scenario = json.load(open(scenario_path, encoding="utf-8"))
rec = json.load(open(cues_path, encoding="utf-8"))
words = json.load(open(words_path, encoding="utf-8"))

probe = subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height:format=duration",
     "-of", "json", video_path],
    capture_output=True, text=True, check=True,
)
info = json.loads(probe.stdout)
src_w, src_h = info["streams"][0]["width"], info["streams"][0]["height"]
video_len = float(info["format"]["duration"])

body = scenario.get("body") or {}
body_start = body.get("start", rec.get("bodyStart", 0.0))
body_end = body.get("end", rec.get("bodyEnd", video_len))
body_start = math.ceil((body_start + EDGE_SAFETY) * FPS) / FPS
body_end = math.floor((min(body_end, video_len) - EDGE_SAFETY) * FPS) / FPS

cues = rec["cues"]
intro_cues = [c for c in cues if c["at"] < body_start]
outro_cues = [c for c in cues if c["at"] + c["dur"] > body_end]
first_at = min((c["at"] for c in intro_cues), default=body_start)
intro_dur = max(MIN_INTRO, body_start - first_at + INTRO_LEAD)
shift = body_start - intro_dur
last_end = max((c["at"] + c["dur"] for c in outro_cues), default=body_end)
outro_dur = max(MIN_OUTRO, last_end - body_end + OUTRO_TAIL)


def recorded_notes():
    notes = []
    for n in rec.get("notes", []):
        start, end = max(n["from"], body_start), min(n["to"], body_end)
        if end - start >= 0.6 and n.get("text"):
            notes.append({"from": round(start - body_start, 2), "to": round(end - body_start, 2),
                          "box": [int(v) for v in n["box"]], "text": n["text"]})
    return notes


def detected_notes():
    texts = [s["highlight"]["note"] for s in scenario["steps"] if s.get("highlight", {}).get("note")]
    if not texts:
        return []
    here = os.path.dirname(os.path.abspath(__file__))
    raw = subprocess.run(
        [sys.executable, os.path.join(here, "detect_boxes.py"), video_path, str(body_start), str(body_end), "5"],
        capture_output=True, text=True, check=True,
    ).stdout
    merged = []
    for s in (s for s in json.loads(raw) if s["box"][2] - s["box"][0] >= 40):
        if merged and merged[-1]["box"] == s["box"] and s["from"] - merged[-1]["to"] <= 0.6:
            merged[-1]["to"] = s["to"]
        else:
            merged.append(dict(s))
    if len(merged) != len(texts):
        sys.exit(f"expected {len(texts)} highlight windows, detected {len(merged)}: {merged}")
    return [{"from": round(m["from"] - body_start, 2), "to": round(m["to"] - body_start, 2), "box": m["box"], "text": t}
            for m, t in zip(merged, texts)]


notes = recorded_notes() or detected_notes()

out = {
    "ticket": scenario["ticket"],
    "title": scenario["title"],
    "subtitle": scenario.get("subtitle", "Demo fitur"),
    "closing": scenario.get("closing", "Terima kasih"),
    "src": {"file": os.path.basename(video_path), "w": src_w, "h": src_h, "start": body_start, "end": body_end},
    "intro": {"dur": round(intro_dur, 3)},
    "outro": {"dur": round(outro_dur, 3)},
    "transition": EXIT,
    "keywords": scenario.get("keywords", []),
    "cues": [
        {"file": os.path.basename(c["file"]), "show": c["show"], "at": round(c["at"] - shift, 3), "dur": c["dur"],
         "words": words[os.path.basename(c["file"])]["words"]}
        for c in cues
    ],
    "notes": notes,
}
json.dump(out, open(out_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print(f"body {body_start:.3f}-{body_end:.3f}s  intro {out['intro']['dur']}s  outro {out['outro']['dur']}s  "
      f"cues {len(out['cues'])}  notes {len(notes)} ({'recorded' if rec.get('notes') else 'detected'})")
