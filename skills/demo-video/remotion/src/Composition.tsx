import {
  AbsoluteFill,
  Composition,
  Easing,
  interpolate,
  Sequence,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";
import { Audio, Video } from "@remotion/media";
import { loadFont } from "@remotion/google-fonts/Inter";
import demo from "./demo.json";
import { Intro } from "./Intro";
import { Outro } from "./Outro";
import { ApiPanel, ComparePanel } from "./ApiPanel";
import type { ApiEntry, CompareEntry } from "./ApiPanel";
import { Checklist } from "./Checklist";
import type { ChecklistEntry } from "./Checklist";

const { fontFamily } = loadFont("normal", { weights: ["500", "600", "700", "800"], subsets: ["latin"] });

const FPS = 30;
const W = 1920;
const H = 1080;
const SCALE = H / demo.src.h;
const VIDEO_W = demo.src.w * SCALE;
const OFFSET_X = (W - VIDEO_W) / 2;

const PINK = "#F472B6";
const DARK = "#0B0B12";

type Word = { w: string; from: number; to: number };
type Cue = { file: string; show: string; at: number; dur: number; words: Word[] };
type Box = [number, number, number, number];
type Note = { from: number; to: number; box: Box; text: string };

const f = (s: number) => Math.round(s * FPS);
const INTRO_F = f(demo.intro.dur);
const OUTRO_F = f(demo.outro.dur);
const BODY_F = f(demo.src.end) - f(demo.src.start);
// No fade transitions: the intro's scale-up IS the transition into the
// body (it lands on the body's exact first frame), and the outro opens
// on the body's exact last frame — a hard cut is the seamless choice.
const TOTAL_F = INTRO_F + BODY_F + OUTRO_F;

const toScreen = (x: number, y: number) => ({ x: OFFSET_X + x * SCALE, y: y * SCALE });
const isKeyword = (w: string) => demo.keywords.includes(w.replace(/[,.:!?]+$/, ""));

const zoomFor = (box: Box) => {
  const bw = (box[2] - box[0]) * SCALE;
  const bh = (box[3] - box[1]) * SCALE;
  return Math.min(1.4, Math.max(1, Math.min((0.8 * W) / bw, (0.55 * H) / bh)));
};

const FillWord: React.FC<{ word: Word; t: number }> = ({ word, t }) => {
  const p = interpolate(t, [word.from, word.to], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const bump = t >= word.from && t <= word.to + 0.12 ? Math.sin(Math.PI * Math.min(1, (t - word.from) / (word.to - word.from + 0.12))) : 0;
  const fill = isKeyword(word.w) ? PINK : "#FFFFFF";
  return (
    <span
      style={{
        position: "relative",
        display: "inline-block",
        marginRight: 14,
        transform: `translateY(${-5 * bump}px) scale(${1 + 0.04 * bump})`,
        transformOrigin: "center bottom",
      }}
    >
      <span style={{ color: "rgba(255,255,255,0.38)" }}>{word.w}</span>
      <span
        style={{
          position: "absolute",
          left: 0,
          top: 0,
          color: fill,
          clipPath: `inset(-20% ${(1 - p) * 100}% -20% 0)`,
          textShadow: isKeyword(word.w) ? `0 0 18px rgba(244,114,182,${0.55 * p})` : "none",
        }}
      >
        {word.w}
      </span>
    </span>
  );
};

const Karaoke: React.FC<{ cue: Cue }> = ({ cue }) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const t = frame / fps;
  const enter = spring({ frame, fps, config: { damping: 20, stiffness: 200 } });
  const exit = interpolate(frame, [durationInFrames - 6, durationInFrames], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  return (
    <AbsoluteFill style={{ justifyContent: "flex-end", alignItems: "center", paddingBottom: 56 }}>
      <div
        style={{
          fontFamily,
          fontSize: 46,
          fontWeight: 700,
          padding: "14px 30px",
          textShadow: "0 2px 6px rgba(0,0,0,0.95), 0 0 2px rgba(0,0,0,0.95)",
          transform: `translateY(${(1 - enter) * 24}px) scale(${0.94 + enter * 0.06})`,
          opacity: Math.min(enter, exit),
          maxWidth: 1560,
          textAlign: "center",
        }}
      >
        {cue.words.map((w, i) => (
          <FillWord key={i} word={w} t={t} />
        ))}
      </div>
    </AbsoluteFill>
  );
};

const CALLOUT_H = 60;

const Callout: React.FC<{ note: Note }> = ({ note }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const pop = spring({ frame: frame - 8, fps, config: { damping: 14, stiffness: 160 } });
  const a = toScreen(note.box[0], note.box[1]);
  const b = toScreen(note.box[2], note.box[3]);
  const gap = 18;
  const CAPTION_ZONE = 260;
  const place = H - b.y > CALLOUT_H + gap + CAPTION_ZONE ? "below" : a.y > CALLOUT_H + gap + 20 ? "above" : "inside";
  const top = place === "below" ? b.y + gap : place === "above" ? a.y - gap - CALLOUT_H : a.y + 24;
  const estWidth = note.text.length * 15 + 48;
  const alignRight = place !== "inside" && a.x + estWidth > W * 0.72;
  const left = place === "inside" ? a.x + 24 : alignRight ? b.x - estWidth : a.x;
  return (
    <div
      style={{
        position: "absolute",
        left,
        top,
        height: CALLOUT_H,
        display: "flex",
        alignItems: "center",
        transform: `scale(${pop})`,
        transformOrigin: `${place === "above" ? "bottom" : "top"} ${alignRight ? "right" : "left"}`,
        background: PINK,
        color: "#1a0b14",
        fontFamily,
        fontSize: 26,
        fontWeight: 800,
        padding: "0 22px",
        borderRadius: 14,
        boxShadow: "0 12px 34px rgba(244,114,182,0.4)",
        whiteSpace: "nowrap",
      }}
    >
      {place !== "inside" && (
        <div
          style={{
            position: "absolute",
            ...(alignRight ? { right: 28 } : { left: 28 }),
            [place === "below" ? "top" : "bottom"]: -9,
            width: 18,
            height: 18,
            background: PINK,
            transform: "rotate(45deg)",
            borderRadius: 3,
          }}
        />
      )}
      <span style={{ position: "relative" }}>{note.text}</span>
    </div>
  );
};

const CHECKLIST = (demo as { checklist?: ChecklistEntry }).checklist;

const ChecklistLayer: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  if (!CHECKLIST || t < CHECKLIST.from - 0.5) return null;
  const bodyLen = BODY_F / FPS;
  const reachesEnd = CHECKLIST.to >= bodyLen - 0.5;
  const entry = { ...CHECKLIST, fadeOutEnd: reachesEnd ? bodyLen + 1.4 : CHECKLIST.to + 0.4 };
  if (t > entry.fadeOutEnd) return null;
  return <Checklist entry={entry} t={t} />;
};

const Body: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const t = frame / fps;
  const notes = demo.notes as Note[];
  let scale = 1;
  let tx = 0;
  let ty = 0;
  for (const n of notes) {
    const z = zoomFor(n.box);
    if (z <= 1.02 || t < n.from - 0.7 || t > n.to + 0.7) continue;
    const ease = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
    const p = Math.min(interpolate(t, [n.from - 0.7, n.from], [0, 1], ease), interpolate(t, [n.to, n.to + 0.7], [1, 0], ease));
    const c = toScreen((n.box[0] + n.box[2]) / 2, (n.box[1] + n.box[3]) / 2 + 30);
    scale = 1 + (z - 1) * p;
    const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));
    tx = clamp((W / 2 - scale * c.x) * p, W - scale * W, 0);
    ty = clamp((H / 2 - scale * c.y) * p, H - scale * H, 0);
  }
  const apis = ((demo as { apis?: ApiEntry[] }).apis ?? []) as ApiEntry[];
  const compares = ((demo as { compares?: CompareEntry[] }).compares ?? []) as CompareEntry[];
  const windows = [...apis, ...compares];
  const splitEase = { extrapolateLeft: "clamp", extrapolateRight: "clamp", easing: Easing.inOut(Easing.cubic) } as const;
  const split = Math.max(
    0,
    ...windows.map((w) =>
      Math.min(interpolate(t, [w.from - 0.5, w.from], [0, 1], splitEase), interpolate(t, [w.to - 0.2, w.to + 0.3], [1, 0], splitEase))
    )
  );
  const SPLIT_SCALE = 0.6;
  const SPLIT_X = 48 - OFFSET_X * SPLIT_SCALE;
  const SPLIT_Y = 150;
  scale = scale + (SPLIT_SCALE - scale) * split;
  tx = tx + (SPLIT_X - tx) * split;
  ty = ty + (SPLIT_Y - ty) * split;
  const activeApi = apis.find((w) => t >= w.from - 0.5 && t <= w.to + 0.3);
  const activeCompare = compares.find((w) => t >= w.from - 0.5 && t <= w.to + 0.3);
  const panelLeft = 48 + VIDEO_W * SPLIT_SCALE + 44;
  return (
    <AbsoluteFill style={{ background: DARK }}>
      {split > 0 && (activeApi || activeCompare) && (
        <div
          style={{
            position: "absolute",
            left: panelLeft,
            top: SPLIT_Y,
            width: W - panelLeft - 48,
            opacity: split,
            transform: `translateX(${(1 - split) * 60}px)`,
          }}
        >
          {activeApi ? <ApiPanel entry={activeApi} t={t} /> : activeCompare ? <ComparePanel entry={activeCompare} t={t} /> : null}
        </div>
      )}
      <AbsoluteFill style={{ transform: `translate(${tx}px, ${ty}px) scale(${scale})`, transformOrigin: "0 0" }}>
        <Video
          src={staticFile(demo.src.file)}
          muted
          trimBefore={f(demo.src.start)}
          trimAfter={f(demo.src.end)}
          style={{ position: "absolute", left: OFFSET_X, top: 0, width: VIDEO_W, height: H }}
        />
        {notes.map((n) => (
          <Sequence key={n.text} from={f(n.from)} durationInFrames={f(n.to - n.from)} layout="none">
            <Callout note={n} />
          </Sequence>
        ))}
      </AbsoluteFill>
    </AbsoluteFill>
  );
};

export const Demo: React.FC = () => {
  const cues = demo.cues as Cue[];
  return (
    <AbsoluteFill style={{ background: DARK }}>
      <Sequence from={0} durationInFrames={INTRO_F}>
        <Intro ticket={demo.ticket} title={demo.title} subtitle={demo.subtitle} dur={demo.intro.dur} />
      </Sequence>
      <Sequence from={INTRO_F} durationInFrames={BODY_F}>
        <Body />
      </Sequence>
      <Sequence from={INTRO_F + BODY_F} durationInFrames={OUTRO_F}>
        <Outro ticket={demo.ticket} title={demo.title} closing={demo.closing} dur={demo.outro.dur} />
      </Sequence>
      {CHECKLIST && (
        <Sequence from={INTRO_F} durationInFrames={BODY_F + OUTRO_F} layout="none">
          <ChecklistLayer />
        </Sequence>
      )}
      {cues.map((c) => (
        <Sequence key={c.file} from={f(c.at)} durationInFrames={f(c.dur + 0.35)}>
          <Audio src={staticFile(c.file)} />
          <Karaoke cue={c} />
        </Sequence>
      ))}
    </AbsoluteFill>
  );
};

export const MyComposition = () => (
  <Composition id="Demo" component={Demo} durationInFrames={TOTAL_F} fps={FPS} width={W} height={H} />
);
