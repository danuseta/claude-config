import json
import os
import re
import shutil
import subprocess
import sys

PINK = "&HB672F4&"
SUNG = "&HFFFFFF&"
UNSUNG = "&H9A9A9A&"
STYLE = "S,Segoe UI Semibold,42,&H00FFFFFF,&H009A9A9A,&H00000000,&H66000000,1,0,0,0,100,100,0,0,1,3,1,2,140,140,46,1"


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


def ass_time(seconds):
    seconds = max(0.0, seconds)
    hours = int(seconds // 3600)
    minutes = int(seconds % 3600 // 60)
    return f"{hours:d}:{minutes:02d}:{seconds % 60:05.2f}"


def normalize(word):
    return re.sub(r"[^\w\-.#]", "", word.lower()).strip(".")


def keyword_positions(words, keywords):
    marked = set()
    norms = [normalize(w) for w in words]
    for keyword in keywords:
        parts = [normalize(p) for p in keyword.split()]
        for start in range(len(norms) - len(parts) + 1):
            window = norms[start:start + len(parts)]
            last = window[-1]
            if window[:-1] == parts[:-1] and (last == parts[-1] or last.startswith(parts[-1] + "-")):
                marked.update(range(start, start + len(parts)))
    return marked


def karaoke_line(text, duration, keywords):
    words = text.replace("{", "(").replace("}", ")").split()
    weights = [len(w) + 1 for w in words]
    total_cs = max(len(words), int(duration * 100 * 0.95))
    marked = keyword_positions(words, keywords)
    parts = []
    for index, word in enumerate(words):
        cs = max(1, round(total_cs * weights[index] / sum(weights)))
        if index in marked:
            parts.append(f"{{\\kf{cs}\\1c{PINK}\\2c{PINK}}}{word}{{\\1c{SUNG}\\2c{UNSUNG}}}")
        else:
            parts.append(f"{{\\kf{cs}}}{word}")
    return " ".join(parts)


def write_subtitles(path, cues, trim, keywords):
    lines = [
        "[Script Info]", "ScriptType: v4.00+", "PlayResX: 1920", "PlayResY: 1080", "WrapStyle: 0", "",
        "[V4+ Styles]",
        "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding",
        f"Style: {STYLE}", "",
        "[Events]", "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ]
    for cue in cues:
        start = cue["at"] - trim
        lines.append(f"Dialogue: 0,{ass_time(start)},{ass_time(start + cue['dur'] + 0.25)},S,,0,0,0,,{karaoke_line(cue['show'], cue['dur'], keywords)}")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(lines))


def write_frame_list(path, frames, start_abs, end_abs):
    entries = []
    usable = [f for f in frames if f["ts"] < end_abs]
    for index, frame in enumerate(usable):
        next_ts = usable[index + 1]["ts"] if index + 1 < len(usable) else end_abs
        begin = max(frame["ts"], start_abs)
        finish = min(next_ts, end_abs)
        if finish <= begin:
            continue
        entries += [f"file '{frame['file']}'", f"duration {finish - begin:.4f}"]
    entries.append(f"file '{usable[-1]['file']}'")
    with open(path, "w", encoding="utf-8") as handle:
        handle.write("\n".join(entries))


def main():
    scenario_path = os.path.abspath(sys.argv[1])
    output = os.path.abspath(sys.argv[2])
    subs_only = "--subs-only" in sys.argv
    workdir = os.path.dirname(scenario_path)
    os.chdir(workdir)
    scenario = load_json(scenario_path)
    recording = load_json("cues.json")
    cues = recording["cues"]
    trim = max(0.0, cues[0]["at"] - 0.6)
    start_abs = recording["t0"] + trim
    end_abs = recording["end"]

    write_subtitles("subs.ass", cues, trim, scenario.get("keywords", []))
    if subs_only:
        print("wrote subs.ass")
        return
    write_frame_list("frames.txt", recording["frames"], start_abs, end_abs)

    ffmpeg = shutil.which("ffmpeg")
    inputs = ["-f", "concat", "-safe", "0", "-i", "frames.txt"]
    filters = []
    labels = []
    for index, cue in enumerate(cues):
        delay = int((cue["at"] - trim) * 1000)
        inputs += ["-i", cue["file"]]
        filters.append(f"[{index + 1}:a]adelay={delay}|{delay}[a{index}]")
        labels.append(f"[a{index}]")
    filters.append("".join(labels) + f"amix=inputs={len(labels)}:normalize=0[aud]")
    filters.append("[0:v]fps=30,scale=1920:1080:force_original_aspect_ratio=decrease:flags=lanczos,pad=1920:1080:(ow-iw)/2:(oh-ih)/2,subtitles=subs.ass[v]")
    result = subprocess.run(
        [ffmpeg, "-v", "error", "-y", *inputs, "-filter_complex", ";".join(filters), "-map", "[v]", "-map", "[aud]",
         "-t", f"{end_abs - start_abs:.2f}", "-c:v", "libx264", "-preset", "slow", "-crf", "16", "-pix_fmt", "yuv420p",
         "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart", output],
        capture_output=True, text=True,
    )
    if result.returncode:
        sys.exit(result.stderr[-800:])
    print(f"wrote {output} ({end_abs - start_abs:.1f}s)")


if __name__ == "__main__":
    main()
