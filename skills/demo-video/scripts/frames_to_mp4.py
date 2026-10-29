"""Turn the CDP screencast frames logged by record.cjs into a constant-30fps recording.mp4.

Usage: python frames_to_mp4.py <cues.json> <out recording.mp4>

The video clock starts at cues.json t0, so every cue "at" and note "from"/"to" is a timestamp in this file.
"""
import json
import os
import subprocess
import sys
import tempfile

cues_path, out_path = sys.argv[1:3]
rec = json.load(open(cues_path, encoding="utf-8"))
t0, end = rec["t0"], rec["end"]
frames = sorted((f for f in rec["frames"] if f["ts"] < end), key=lambda f: f["ts"])
if not frames:
    sys.exit("no frames in cues.json")


def entry(path):
    return "file '" + os.path.abspath(path).replace("\\", "/").replace("'", "'\\''") + "'"


lines = []
for i, frame in enumerate(frames):
    begin = t0 if i == 0 else max(frame["ts"], t0)
    finish = frames[i + 1]["ts"] if i + 1 < len(frames) else end
    if finish > begin:
        lines += [entry(frame["file"]), f"duration {finish - begin:.4f}"]
lines.append(entry(frames[-1]["file"]))

with tempfile.NamedTemporaryFile("w", suffix=".txt", delete=False, encoding="utf-8") as handle:
    handle.write("\n".join(lines))
    list_path = handle.name

subprocess.run(
    ["ffmpeg", "-v", "error", "-y", "-f", "concat", "-safe", "0", "-i", list_path,
     "-vf", "fps=30,scale=1920:1080:flags=lanczos", "-c:v", "libx264", "-preset", "slow", "-crf", "16",
     "-pix_fmt", "yuv420p", "-an", "-movflags", "+faststart", out_path],
    check=True,
)
os.remove(list_path)
print(f"{out_path}: {end - t0:.2f}s from {len(frames)} frames")
