---
name: demo-video
description: Use when making a narrated demo video of a Qonflo ticket or PR (for the boss or a reviewer). Writes Indonesian narration from the AC, voices it with ElevenLabs (Chris), records the local app headless in sharp 1080p as a real demo (a visible cursor that glides to each target and clicks, navigation by clicking, no jumps), and renders the final video in Remotion with an editorial intro, karaoke subtitles, zoom-and-callout notes on the component being discussed, the AC checklist before the outro, and a calm outro.
---

> On the Linux workspace, read the Machine map at the top of `AGENTS.md` first: it maps the Windows paths and commands below.

# Demo video for a Qonflo ticket

The viewer has not read the code. Show the behaviour, say what matters, point at it.

Everything here lives next to this file:
- `scripts/` holds the Python and Node steps.
- `remotion/` holds the video template.
- `lexicon.json` holds the pronunciation table.

Work in a scratch folder, never in a repo.

## Rules

- **Data and screen.** Record the local stack (FE + BE) on test data you created, never real customer data. Dark mode, 1920×1080, 30 fps.
- **Keys.** The ElevenLabs keys live in DOCK and rotate. Before the TTS and alignment runs, set the env from the rotation: `export ELEVENLABS_API_KEY="$(node <kitDir>/el-rotate.cjs get)"`. When a run fails with 401, 402 or 429, run `node <kitDir>/el-rotate.cjs park`, take the next key the same way and run again. Never write a key to a file or a script, and never echo it or paste it into chat.
- **Recording.** Record headless only. OBS and screen capture record whatever is on the user's screen.
- **Look.**
  - Intro is "editorial": a left-aligned headline, a mono caption with the ticket, and a real frame of the demo that scales up into the body.
  - Outro is "darken the UI → Terima kasih", with a caption of ticket · title.
  - No Qonflo wordmark in the outro and no recap list.
  - No AI-slop visuals: no gradient blobs, particles, glow rings, glass pills or flash transitions.
  - Subtitles have no background box. The words sit directly on the video with only a thin dark text shadow for legibility.
- **Licence.** Remotion is free only for individuals and companies of up to 3 people, and Qonflo is larger. Check the Company License (remotion.pro/license) before using this for official work.

## Demo, not slides

The viewer must see every move, the way a person would do it. Nothing changes on screen without the cursor causing it.

- `record.cjs` draws a visible cursor. Before every `click`, `hover`, `type` and highlight it glides from its last position to the target, pauses, then clicks with a pink ring. `"cursor": false` in the scenario turns it off.
- Move between pages by clicking the real navigation (`click` on the menu link), never with `goto`. `goto` and `eval` are for setup before the first body step only; the recorder warns when one runs while recording.
- `type` with a `selector` clicks the field first, then types at 70 ms per character.
- `scroll` (`by`, optional `selector`) and `scrollTop` use the mouse wheel in small steps, so the page slides instead of jumping.
- Highlight frames fade in after the cursor reaches the component. Number the notes (`"1. Filter channel"`, `"2. Cari chat"`) so the steps read in order.
- The demo style changes only how the body is filmed. A ticket demo still ends with the AC checklist scene (step 7c) before the outro.
- `storageState` in the scenario reuses a saved login (e.g. `E:/qonflo/.evidence/<KEY>/auth-<port>.json`) instead of `login`.

## Narration and pronunciation

The default voice stays ElevenLabs **Chris** (`iP95p4xoKVk53GoZ742B`) on `eleven_v3`, reading Indonesian. Use another voice only when the user names one for that ticket (QRD-1250 used Sarah `EXAVITQu4vr4xnSDxMaL` on `eleven_v4`). On the free plan only premade voices work through the API; library voices return 402. An American-accented voice can read the Indonesian "c" as "k" (baca → "baka"), so `--test` a line with Indonesian c-words before the full run. English words and English-read numbers sound wrong, so every English term in the narration must do one of two things:
- go through `lexicon.json` (Save → sef, chip → cip, pointer → poin-ter, workflow → werk-flou, SKILL.md → skil dot em de), or
- be rephrased in Indonesian.

`tts.py` also speaks identifiers in Indonesian on its own:
- `QRD-1261` → "Q R D dua belas enam puluh satu";
- `AC4` → "A C empat";
- `PR #928` → "P R sembilan dua delapan".

A scenario can add its own terms under `"lexicon"`. Subtitles always show the written form (`QRD-1261`, `SKILL.md`), and `align.py` maps the spoken words back onto them.

Write narration the way people talk:
- short sentences, one idea each, 1–2 lines per step;
- rhythm words such as "Oke,", "Nah,", "?";
- say what to look at.

## Steps

1. **Scenario.** Copy `scenario.example.json` to the scratch folder and fill it in from the AC.
   - Steps marked `"part": "intro"` or `"part": "outro"` are narration over the Remotion intro/outro. Nothing is filmed for them.
   - Every step that talks about a component gets a `highlight` with a short `note`, which becomes the callout.
   - `keywords` are shown in pink in the subtitles.
1b. **Probe with `playwright-cli`, not with scripts.** Find and prove every selector and click of the scenario before recording.
   - Start from what already works: the ticket's `E:/qonflo/.evidence/<KEY>/scripts` and screenshots, and the recorder of an earlier demo. Reuse a proven selector as it is.
   - For anything new, drive the page with the `playwright-cli` skill, one short command per step. Its snapshots go to files, so only what you grep out of them enters the context.
   - Do not write `probe*.cjs` files. Each one has to be written, run and fixed, and that is where the tokens of a demo go: QRD-1248 took 96 tool calls, most of them probes.
   - The only script is the recorder, and it runs twice at most: one dry pass without audio to confirm the cues, then the real recording.
2. **Pronunciation check.** Do this before spending characters on the full run.
   ```
   python scripts/tts.py <work>/scenario.json --say
   python scripts/tts.py <work>/scenario.json --test "Baru pas di-Save, servernya nolak."
   ```
   `--say` prints every line's spoken form for free. `--test` voices a single line to `<work>/audio/pronunciation-test.mp3`: listen to it, then fix the lexicon or reword the line.
3. **Voice.**
   ```
   python scripts/tts.py <work>/scenario.json
   ```
   This writes `<work>/audio/*.mp3` and `<work>/audio.json`. Set `voice.provider = "edge"` for a free draft while the script is still changing. Edge needs `edge-tts` 7.3 or newer; older versions get `403` from Bing.
4. **Record.**
   ```
   node scripts/record.cjs <work>/scenario.json
   python scripts/frames_to_mp4.py <work>/cues.json <work>/recording.mp4
   ```
   - The capture is headless Chrome with `--force-device-scale-factor=1.35` and a `1436×893` window. CDP screencast frames come out at 1920×1080, which is what keeps the text sharp.
   - Each highlight is outlined in pink on the page. Its `getBoundingClientRect()` and time window are logged to `cues.json → notes`, together with `bodyStart`/`bodyEnd`.
   - `--legacy-cards` brings back the old baked intro/outro cards and note labels. Use it only with the legacy `compose.py`.
5. **Word timing.**
   ```
   python scripts/align.py <work>/audio.json <work>/audio <work>/words.json
   ```
   This uses ElevenLabs forced alignment on the existing audio; nothing is regenerated. Without the key, it falls back to a length estimate and says so.
6. **Remotion input.**
   ```
   python scripts/build_input.py <work>/scenario.json <work>/cues.json <work>/words.json <work>/recording.mp4 <work>/demo.json
   ```
   Callout boxes come from the recorded notes. Old recordings without them fall back to `detect_boxes.py`, which finds the pink outline in the frames.
7. **Render.**
   ```
   cp -r remotion <work>/video && cd <work>/video && npm i
   cp <work>/recording.mp4 <work>/audio/*.mp3 public/
   cp <work>/demo.json src/demo.json
   npx tsc --noEmit
   npx remotion render Demo out/demo.mp4 --codec=h264 --crf=16 --concurrency=2
   ```
   Without `--concurrency=2` the render died with `Error: write EOF` when the laptop was short on memory.
   Use `npm run dev` (Remotion Studio) to preview before rendering.

   Then upload it: `node <kitDir>/demo-upload.cjs <KEY> <work>/video/out/demo.mp4`. It goes into DOCK's bucket as `<KEY>.mp4` and prints the permanent link. The ticket page of both DOCKs shows it and the Discord broadcast uses it; give the owner that link. A new render for the same ticket replaces the video and keeps the link.
7b. **Optional layers in `demo.json`.** Each is optional. An input without them renders exactly as before.

   The times below are body seconds, i.e. seconds after `src.start`.
   - `apis: [{ from, to, label?, calls: [{ at, method, path, body, status, rows: [{ k, v }] }], hl: [{ key, from, to }] }]`
     - The body shrinks to the left and an API request/response card appears on the right.
     - `hl` highlights a row (`key` = row `k`, or `status` / `request`) in sync with the narration.
     - With 3 or more calls the cards switch to compact mode.
   - `compares: [{ from, to, label?, version, path, storagePath, bytes, identical, text }]` shows the same split with a text panel and an "Identik dengan Preview" verdict.
   - `checklist: { from, to, lines?, title, rows: [{ ac, contract, evidence, line?, partial? }], footer?: { title, items } }` covers the screen with a table that ticks row by row.
     - `lines` are the body times of the narration lines; `line` is the row's line index. Without them the rows are spread evenly.
     - `partial: true` marks a row that is not finished: it still highlights when its line is spoken, but its box stays empty and never gets a tick.
     - A checklist that runs to the end of the body fades out over the outro veil instead of cutting to raw UI.

   `scripts/record-api.example.cjs` and `session.example.cjs` show how to produce `apis` and `compares`: an `api` action per step, with `then` / `atLine` / `hl` / `pick`, plus a `checklist: true` step.
   Copy them into the work folder, then set `DEMO_FE`, `DEMO_API` and `DEMO_PASSWORD_FILE`.
7c. **Ticket demos end with a checklist.** For a ticket demo, add a checklist scene "AC tiket × kontrak × implementasi" just before the outro.
   - Give one row per AC line, plus the contract rules the ticket must follow.
   - Each row carries its contract § and evidence with the video timestamp that proves it (`… · 1:12`).
   - Anything proven only in code, not on screen, says `kode: <symbol>` rather than pointing at a scene.
   - An AC line that is only partly done, or waits for another ticket, gets `partial: true` and says so in its text. Never tick it: the QRD-1376 video first shipped "SEBAGIAN, belum selesai" with a tick next to it.
   - Keep every cell to two lines at most, `ac`, `contract` and `evidence` alike, and the footer to one or two. The subtitles sit over the bottom fifth of the frame: with eight rows, two cells of three lines pushed row 8 and the footer under them in the QRD-1248 video. Shorten the wording, keep every AC line.
   - Look at a still of the last checklist line before handing over: every row and the footer must be clear of the subtitle.
   - Decisions the contract left open, such as numbers it does not state, go in the `footer` card.
8. **Verify.**
   - Check duration and audio with `ffprobe`.
   - Look at stills with `npx remotion still Demo out/f.png --frame=N`:
     - intro mid-hold;
     - the last intro frame against the first body frame. They must be identical real UI.
     - a zoom + callout moment;
     - outro mid-veil;
     - the final frame.
   - Sample every 0.5s over the first and last 15s. No leftover Playwright card may appear anywhere.
   - Hand over the mp4 path, its length, and one line per part.

## Pitfalls already paid for

- **Source frame rate.** Recordings can be 25 fps while the composition is 30 fps. `build_input.py` snaps `src.start`/`end` inward to whole frames with a 0.1s margin.
- **Decode offset.** `@remotion/media` decodes a slightly different frame than `ffmpeg -ss` at the same second. Calibrate cut points with Remotion stills, not ffmpeg.
- **Letterbox.** A 16:10 source (1440×900) is letterboxed in the 16:9 canvas. The intro's product frame uses the source aspect and scales up to the body's on-screen rect, so the cut stays pixel-identical.
- **TransitionSeries.** Fades between scenes move the body 0.6s earlier than the cue timings assume. Use hard cuts; the intro scale-up is the transition.
- **Intro length.** The entrance takes about 2.5s and the exit 0.6s. Keep the intro at 3.5s or more (`build_input.py` enforces it), and let intro narration lengthen it rather than overlap the entrance.

- **Disk space on C:.** Remotion, Chrome and npm caches plus the frame dumps filled C: once, and local MongoDB stopped with it.
  - Do all the work on E: (e.g. `E:/qonflo/<date>/<ticket>`).
  - Install with `npm_config_cache=E:/qonflo/<date>/.npm-cache`.
  - Delete the template copy's `node_modules` when you are done.
- **Notification dialog.** "Enable Notifications" can pop up over any page. `record.cjs` and the API recorder click "Maybe Later" automatically. If you write a new recorder, keep that init script.

## Legacy

`scripts/compose.py` (ffmpeg + ASS subtitles) is the old pipeline. Keep it only as a fallback when Remotion can't run. It needs `record.cjs --legacy-cards`.

## Never

- Commit the video, the scratch folder, the scenario or the template's `node_modules` into a repo.
- Record with OBS, screen capture or a screenshot loop.
- Spend ElevenLabs characters on a test run. Use `--say`, one `--test` line, or `edge` first.
