import React from "react";
import { AbsoluteFill, Freeze, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import { loadFont as loadHeadlineFont } from "@remotion/google-fonts/PlusJakartaSans";
import { loadFont as loadMonoFont } from "@remotion/google-fonts/JetBrainsMono";
import { KineticHeadline } from "./KineticHeadline";
import { MetaCaption } from "./MetaCaption";
import { COLORS, MARGIN_LEFT, W, H, safeContentStyle, wrapHeadline, type SceneProps } from "./theme";
import demo from "./demo.json";

const { fontFamily: headlineFont } = loadHeadlineFont("normal", { weights: ["800"], subsets: ["latin"] });
const { fontFamily: monoFont } = loadMonoFont("normal", { weights: ["500"], subsets: ["latin"] });

// Same math as Composition.tsx's Body layer, so the frozen last frame is
// pixel-identical to what the demo body just showed.
const FPS = 30;
const SCALE = H / demo.src.h;
const VIDEO_W = demo.src.w * SCALE;
const OFFSET_X = (W - VIDEO_W) / 2;
const f = (s: number) => Math.round(s * FPS);
const BODY_LAST_LOCAL_FRAME = f(demo.src.end) - f(demo.src.start) - 1;

/**
 * Idea 04 — "darken the UI -> Terima kasih": the outro opens on the exact
 * last frame of the demo, full screen (seamless cut from the body), then
 * a slow push-in and a dark veil settle in behind a calm closing caption.
 */
export const Outro: React.FC<SceneProps & { closing?: string }> = ({ ticket, title, closing, dur }) => {
  const frame = useCurrentFrame();
  const durFrames = Math.round((dur ?? 7.971) * FPS);

  // Very slow, linear push-in across the whole outro (matches the mockup:
  // scale 1 -> 1.08, no easing) — at frame 0 this is scale(1), i.e. no
  // transform at all, so the cut from the body is exact.
  const pushScale = interpolate(frame, [0, durFrames], [1, 1.08], { extrapolateRight: "clamp" });

  // Dark veil settles in over ~1.4s, starting ~0.3s in.
  const veilOpacity = interpolate(frame, [f(0.3), f(0.3) + f(1.4)], [0, 0.9], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const headlineFontSize = 96;
  const maxCharsPerLine = Math.floor((W - MARGIN_LEFT * 2) / (headlineFontSize * 0.52));
  const lines = wrapHeadline(closing ?? "Terima kasih", maxCharsPerLine);

  const headlineStart = f(1.2);
  const captionStart = f(1.6);
  const caption = `${ticket} · ${title}`;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      <AbsoluteFill style={{ transform: `scale(${pushScale})`, transformOrigin: "50% 50%" }}>
        <Freeze frame={BODY_LAST_LOCAL_FRAME}>
          <Video
            src={staticFile(demo.src.file)}
            muted
            trimBefore={f(demo.src.start)}
            trimAfter={f(demo.src.end)}
            style={{ position: "absolute", left: OFFSET_X, top: 0, width: VIDEO_W, height: H }}
          />
        </Freeze>
      </AbsoluteFill>

      <AbsoluteFill style={{ background: COLORS.bg, opacity: veilOpacity }} />

      <div style={safeContentStyle}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingLeft: MARGIN_LEFT,
          }}
        >
          <KineticHeadline lines={lines} startFrame={headlineStart} fontFamily={headlineFont} fontSize={headlineFontSize} />

          <div style={{ marginTop: 26 }}>
            <MetaCaption text={caption} startFrame={captionStart} fontFamily={monoFont} />
          </div>
        </div>
      </div>
    </AbsoluteFill>
  );
};
