"""Find the pink highlight outline baked into a recording and return its box per time window.

Usage: python scripts/detect_boxes.py <video> <from> <to> [fps]
Prints JSON segments: [{"from", "to", "box": [x1, y1, x2, y2]}] in source video pixels.
"""
import json
import subprocess
import sys

import numpy as np

video, t_from, t_to = sys.argv[1], float(sys.argv[2]), float(sys.argv[3])
fps = float(sys.argv[4]) if len(sys.argv) > 4 else 5
probe = subprocess.run(
    ["ffprobe", "-v", "error", "-select_streams", "v:0", "-show_entries", "stream=width,height", "-of", "csv=p=0", video],
    capture_output=True, text=True, check=True,
)
w, h = map(int, probe.stdout.strip().split(","))
raw = subprocess.run(
    ["ffmpeg", "-v", "error", "-ss", str(t_from), "-to", str(t_to), "-i", video, "-vf", f"fps={fps}",
     "-f", "rawvideo", "-pix_fmt", "rgb24", "-"],
    capture_output=True, check=True,
).stdout
frames = np.frombuffer(raw, dtype=np.uint8).reshape(-1, h, w, 3).astype(np.int16)


def box_of(f):
    r, g, b = f[..., 0], f[..., 1], f[..., 2]
    mask = (r > 200) & (b > 140) & (r - g > 90) & (b - g > 40)
    ys, xs = np.nonzero(mask)
    if len(xs) < 80:
        return None
    rows = np.bincount(ys, minlength=h)
    cols = np.bincount(xs, minlength=w)
    # the outline is a rectangle: keep rows/cols dense enough to be an edge, drop stray pink text
    edge_rows = np.nonzero(rows > 0.3 * rows.max())[0]
    edge_cols = np.nonzero(cols > 0.3 * cols.max())[0]
    if len(edge_rows) == 0 or len(edge_cols) == 0:
        return None
    return [int(edge_cols.min()), int(edge_rows.min()), int(edge_cols.max()), int(edge_rows.max())]


segments = []
for i, f in enumerate(frames):
    t = round(t_from + i / fps, 2)
    b = box_of(f)
    last = segments[-1] if segments else None
    if b and last and last["box"] and max(abs(p - q) for p, q in zip(b, last["box"])) <= 8 and t - last["to"] <= 1.5 / fps:
        last["to"] = t
    elif b:
        segments.append({"from": t, "to": t, "box": b})
print(json.dumps([s for s in segments if s["to"] - s["from"] >= 0.6]))
