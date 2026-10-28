import json
import os
import re
import shutil
import subprocess
import sys
import urllib.request

SKILL_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def load_json(path):
    with open(path, encoding="utf-8") as handle:
        return json.load(handle)


ONES = ["nol", "satu", "dua", "tiga", "empat", "lima", "enam", "tujuh", "delapan", "sembilan"]


def angka(n):
    if n < 10:
        return ONES[n]
    if n == 10:
        return "sepuluh"
    if n == 11:
        return "sebelas"
    if n < 20:
        return f"{ONES[n - 10]} belas"
    if n < 100:
        tens, rest = divmod(n, 10)
        return f"{ONES[tens]} puluh" + (f" {ONES[rest]}" if rest else "")
    if n < 1000:
        hundreds, rest = divmod(n, 100)
        head = "seratus" if hundreds == 1 else f"{ONES[hundreds]} ratus"
        return head + (f" {angka(rest)}" if rest else "")
    thousands, rest = divmod(n, 1000)
    head = "seribu" if thousands == 1 else f"{angka(thousands)} ribu"
    return head + (f" {angka(rest)}" if rest else "")


def digits(number):
    return " ".join(ONES[int(d)] for d in number)


def pairs(number):
    if len(number) != 4:
        return digits(number)
    return " ".join(angka(int(p)) if p[0] != "0" else digits(p) for p in (number[:2], number[2:]))


def spell_letters(word):
    return " ".join(word.upper())


def speak_ids(text):
    text = re.sub(r"\b([A-Z]{2,5})-(\d+)\b", lambda m: f"{spell_letters(m.group(1))} {pairs(m.group(2))}", text)
    text = re.sub(r"\bPR\s*#\s*(\d+)", lambda m: f"P R {digits(m.group(1))}", text)
    text = re.sub(r"\bAC(\d+)\b", lambda m: f"A C {angka(int(m.group(1)))}", text)
    return text


def replace_words(text, table):
    for key in sorted(table, key=len, reverse=True):
        flags = 0 if key.isupper() else re.IGNORECASE
        text = re.sub(rf"(?<!\w){re.escape(key)}(?!\w)", table[key], text, flags=flags)
    return text


def spoken_text(show, scenario, lexicon):
    text = show
    if scenario.get("ticket") and scenario.get("spokenTicket"):
        text = text.replace(scenario["ticket"], scenario["spokenTicket"])
    table = {**lexicon.get("spoken", {}), **scenario.get("lexicon", {})}
    text = replace_words(text, table)
    return speak_ids(text)


def synth_elevenlabs(text, voice, out_path):
    key = os.environ.get("ELEVENLABS_API_KEY")
    if not key:
        sys.exit("ELEVENLABS_API_KEY is not set; use voice.provider = edge or set the key")
    body = json.dumps({"text": text, "model_id": voice.get("model", "eleven_v3"), "voice_settings": {"stability": voice.get("stability", 0.5)}}).encode()
    url = f"https://api.elevenlabs.io/v1/text-to-speech/{voice['voiceId']}?output_format=mp3_44100_128"
    request = urllib.request.Request(url, data=body, headers={"xi-api-key": key, "Content-Type": "application/json"})
    with urllib.request.urlopen(request, timeout=120) as response, open(out_path, "wb") as handle:
        handle.write(response.read())


def synth_edge(text, voice, out_path):
    args = [sys.executable, "-m", "edge_tts", "--voice", voice.get("voice", "id-ID-ArdiNeural"), f"--rate={voice.get('rate', '+8%')}", "--text", text, "--write-media", out_path]
    if voice.get("pitch"):
        args.insert(-4, f"--pitch={voice['pitch']}")
    subprocess.run(args, check=True, capture_output=True)


def duration_of(path):
    probe = shutil.which("ffprobe")
    result = subprocess.run([probe, "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", path], capture_output=True, text=True, check=True)
    return float(result.stdout.strip())


def main():
    scenario_path = os.path.abspath(sys.argv[1])
    workdir = os.path.dirname(scenario_path)
    scenario = load_json(scenario_path)
    lexicon = load_json(os.path.join(SKILL_DIR, "lexicon.json"))
    voice = scenario.get("voice", {"provider": "edge"})
    provider = voice.get("provider", "edge")
    os.makedirs(os.path.join(workdir, "audio"), exist_ok=True)

    if len(sys.argv) > 2 and sys.argv[2] == "--say":
        for step in scenario["steps"]:
            for show in step.get("lines", []):
                print(f"{show}\n  -> {spoken_text(show, scenario, lexicon)}")
        return
    if len(sys.argv) > 3 and sys.argv[2] == "--test":
        say = spoken_text(sys.argv[3], scenario, lexicon)
        out_path = os.path.join(workdir, "audio", "pronunciation-test.mp3")
        (synth_elevenlabs if provider == "elevenlabs" else synth_edge)(say, voice, out_path)
        print(f"{say}\n{out_path}")
        return

    steps = []
    characters = 0
    for step_index, step in enumerate(scenario["steps"]):
        lines = []
        for line_index, show in enumerate(step.get("lines", [])):
            say = spoken_text(show, scenario, lexicon)
            out_path = os.path.join(workdir, "audio", f"a_{step_index:02d}_{line_index}.mp3")
            if provider == "elevenlabs":
                synth_elevenlabs(say, voice, out_path)
            else:
                synth_edge(say, voice, out_path)
            characters += len(say)
            lines.append({"file": out_path, "show": show, "say": say, "dur": duration_of(out_path)})
        steps.append({"lines": lines})

    with open(os.path.join(workdir, "audio.json"), "w", encoding="utf-8") as handle:
        json.dump(steps, handle, ensure_ascii=False, indent=1)
    total = sum(line["dur"] for step in steps for line in step["lines"])
    print(f"provider={provider} lines={sum(len(s['lines']) for s in steps)} characters={characters} speech={total:.1f}s")


if __name__ == "__main__":
    main()
