"""Word timings per cue via ElevenLabs forced alignment, mapped back to the shown text.

Usage: python scripts/align.py <audio.json> <audio_dir> <out.json>
The key comes from the kit's el-rotate.cjs rotation (el_keys.py): a spent key is parked and the next one tried, until every
key is parked. Never prints a key. Without a usable key every line falls back to a character-length estimate, and the keys
tried are listed with their reasons.
"""
import difflib
import json
import os
import re
import sys
import uuid

import el_keys

audio_json, public_dir, out_path = sys.argv[1:4]
keys = el_keys.Keys()
parked = None


def norm(w):
    return re.sub(r"[^\w]", "", w.lower())


def post_alignment(mp3_path, text):
    boundary = uuid.uuid4().hex
    with open(mp3_path, "rb") as f:
        audio = f.read()
    body = b"".join([
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"text\"\r\n\r\n{text}\r\n".encode("utf-8"),
        f"--{boundary}\r\nContent-Disposition: form-data; name=\"file\"; filename=\"a.mp3\"\r\nContent-Type: audio/mpeg\r\n\r\n".encode("utf-8"),
        audio,
        f"\r\n--{boundary}--\r\n".encode("utf-8"),
    ])
    raw = el_keys.post("/forced-alignment", body, {"Content-Type": f"multipart/form-data; boundary={boundary}"}, 60, keys)
    return json.loads(raw.decode("utf-8"))


def estimate(shown, dur):
    words = shown.split(" ")
    total = sum(len(w) for w in words)
    acc, out = 0, []
    for w in words:
        s = acc / total * dur
        acc += len(w)
        out.append({"w": w, "from": round(s, 3), "to": round(acc / total * dur, 3)})
    return out


def map_words(shown, spoken):
    shown_w = shown.split(" ")
    sm = difflib.SequenceMatcher(a=[norm(w) for w in shown_w], b=[norm(s["text"]) for s in spoken], autojunk=False)
    out = [None] * len(shown_w)
    for op, a0, a1, b0, b1 in sm.get_opcodes():
        if op == "equal":
            for k in range(a1 - a0):
                s = spoken[b0 + k]
                out[a0 + k] = {"w": shown_w[a0 + k], "from": s["start"], "to": s["end"]}
        elif a1 > a0:
            if b1 > b0:
                start, end = spoken[b0]["start"], spoken[b1 - 1]["end"]
            else:
                prev = spoken[b0 - 1]["end"] if b0 > 0 else 0
                start = end = prev
            chunk = shown_w[a0:a1]
            total = sum(len(w) for w in chunk) or 1
            acc = 0
            for k, w in enumerate(chunk):
                s = start + (end - start) * acc / total
                acc += len(w)
                out[a0 + k] = {"w": w, "from": s, "to": start + (end - start) * acc / total}
    return [{"w": o["w"], "from": round(o["from"], 3), "to": round(o["to"], 3)} for o in out]


result, failures = {}, []
for step in json.load(open(audio_json, encoding="utf-8")):
    for line in step["lines"]:
        try:
            if parked:
                raise parked
            data = post_alignment(os.path.join(public_dir, line["file"]), line["say"])
            spoken = [w for w in data.get("words", []) if w["text"].strip()]
            result[os.path.basename(line["file"])] = {"source": "alignment", "words": map_words(line["show"], spoken)}
        except el_keys.KeysParked as e:
            parked = e
            failures.append(f"{line['file']}: KeysParked")
            result[os.path.basename(line["file"])] = {"source": "estimate", "words": estimate(line["show"], line["dur"])}
        except Exception as e:  # noqa: BLE001
            failures.append(f"{line['file']}: {type(e).__name__} {getattr(e, 'code', '')}")
            result[os.path.basename(line["file"])] = {"source": "estimate", "words": estimate(line["show"], line["dur"])}

json.dump(result, open(out_path, "w", encoding="utf-8"), indent=1, ensure_ascii=False)
print("aligned:", sum(v["source"] == "alignment" for v in result.values()), "/", len(result))
for f in failures:
    print("FAIL", f)
if parked:
    print(f"ELEVENLABS ALL KEYS PARKED: {parked}")
    for name, reason in parked.tried:
        print(f"  {name}: {reason}")
