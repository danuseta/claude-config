import React from "react";
import { AbsoluteFill, Easing, Freeze, interpolate, staticFile, useCurrentFrame } from "remotion";
import { Video } from "@remotion/media";
import { loadFont as loadHeadlineFont } from "@remotion/google-fonts/PlusJakartaSans";
import { loadFont as loadMonoFont } from "@remotion/google-fonts/JetBrainsMono";
import { Baselines } from "./Baselines";
import { KineticHeadline } from "./KineticHeadline";
import { MetaCaption } from "./MetaCaption";
import { Timecode } from "./Timecode";
import { COLORS, EXIT_EASE, MARGIN_LEFT, REVEAL_EASE, SUBTITLE_SAFE_BOTTOM, W, H, safeContentStyle, wrapHeadline, type SceneProps } from "./theme";
import demo from "./demo.json";

const { fontFamily: headlineFont } = loadHeadlineFont("normal", { weights: ["800"], subsets: ["latin"] });
const { fontFamily: monoFont } = loadMonoFont("normal", { weights: ["500"], subsets: ["latin"] });

// Same math as Composition.tsx's Body layer — kept in lock-step so the
// product-frame preview is pixel-identical to the demo body it hands off to.
const FPS = 30;
const SCALE = H / demo.src.h;
const VIDEO_W = demo.src.w * SCALE;
const OFFSET_X = (W - VIDEO_W) / 2;
const f = (s: number) => Math.round(s * FPS);

type Box = { x: number; y: number; w: number; h: number };

// The exit target is EXACTLY the body's on-screen video rect (1728x1080 at
// x=96,y=0) — not the full 1920x1080 canvas. That's what makes the last
// intro frame and the body's first frame pixel-identical: same rect, same
// frozen frame, same crop.
const FULL_BOX: Box = { x: OFFSET_X, y: 0, w: VIDEO_W, h: H };

// Rest state: right-aligned, ~46% of the width, matching the CONTENT's own
// 16:10 aspect (same as FULL_BOX, since VIDEO_W/H is fixed) — so there is
// zero letterboxing inside the box and the scale-up is a pure uniform
// transform with no distortion at any point.
const FRAME_W = Math.round(W * 0.46);
const FRAME_H = Math.round((FRAME_W * FULL_BOX.h) / FULL_BOX.w);
const FRAME_MARGIN_RIGHT = 140;
const REST_BOX: Box = {
  x: W - FRAME_MARGIN_RIGHT - FRAME_W,
  y: Math.round((H - SUBTITLE_SAFE_BOTTOM - FRAME_H) / 2),
  w: FRAME_W,
  h: FRAME_H,
};

const ProductFrame: React.FC<{ startFrame: number; exitStart: number; exitEnd: number }> = ({ startFrame, exitStart, exitEnd }) => {
  const frame = useCurrentFrame();

  const enter = interpolate(frame - startFrame, [0, 20], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...REVEAL_EASE),
  });
  const enterY = interpolate(enter, [0, 1], [16, 0]);
  const enterOpacity = interpolate(frame - startFrame, [0, 14], [0, 1], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const exitP = interpolate(frame, [exitStart, exitEnd], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...EXIT_EASE),
  });

  const box: Box = {
    x: interpolate(exitP, [0, 1], [REST_BOX.x, FULL_BOX.x]),
    y: interpolate(exitP, [0, 1], [REST_BOX.y + enterY, FULL_BOX.y]),
    w: interpolate(exitP, [0, 1], [REST_BOX.w, FULL_BOX.w]),
    h: interpolate(exitP, [0, 1], [REST_BOX.h, FULL_BOX.h]),
  };

  // Border fades out well before the box reaches full screen, matching the
  // mockup's `border-color:transparent` end state.
  const borderOpacity = interpolate(exitP, [0, 0.5], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" }) * enterOpacity;

  return (
    <div
      style={{
        position: "absolute",
        left: box.x,
        top: box.y,
        width: box.w,
        height: box.h,
        overflow: "hidden",
        opacity: enterOpacity,
        border: `1px solid rgba(42,47,58,${borderOpacity})`,
      }}
    >
      {/* Box aspect always matches the content's own 16:10 aspect (both
          REST_BOX and FULL_BOX share it, and interpolating matching-aspect
          rects independently on x/y/w/h stays a uniform scale throughout),
          so the video just fills the box at 100% — no crop, no distortion.
          At exitP=1 the box equals FULL_BOX exactly, which is pixel-for-
          pixel how Composition.tsx's Body renders its own first frame. */}
      <Freeze frame={0}>
        <Video
          src={staticFile(demo.src.file)}
          muted
          trimBefore={f(demo.src.start)}
          trimAfter={f(demo.src.end)}
          style={{ width: "100%", height: "100%" }}
        />
      </Freeze>
    </div>
  );
};

const IntroContent: React.FC<SceneProps> = ({ ticket, title, subtitle, dur }) => {
  const frame = useCurrentFrame();
  const durFrames = Math.round((dur ?? 9.646) * FPS);
  const exitLen = f(demo.transition);
  const exitStart = durFrames - exitLen;
  // Land exactly on the last valid local frame so the next Sequence (the
  // demo body's frame 0) is pixel-identical — no residual gap on the cut.
  const exitEnd = durFrames - 1;

  const headlineFontSize = 84;
  const maxCharsPerLine = Math.floor((REST_BOX.x - MARGIN_LEFT - 60) / (headlineFontSize * 0.52));
  const lines = wrapHeadline(title, maxCharsPerLine);

  const captionStart = 0;
  const headlineStart = 10;
  const frameStart = 16;
  const timecodeStart = 60;

  const contentFade = interpolate(frame, [exitStart, exitStart + 10], [1, 0], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });
  const contentSink = interpolate(frame, [exitStart, exitStart + 10], [0, 14], { extrapolateLeft: "clamp", extrapolateRight: "clamp" });

  const caption = subtitle ? `${ticket} · ${subtitle}` : ticket;

  return (
    <AbsoluteFill>
      <Baselines />

      <div style={{ ...safeContentStyle, opacity: contentFade, transform: `translateY(${contentSink}px)` }}>
        <div
          style={{
            position: "absolute",
            inset: 0,
            display: "flex",
            flexDirection: "column",
            justifyContent: "center",
            paddingLeft: MARGIN_LEFT,
            maxWidth: REST_BOX.x - 40,
          }}
        >
          <div style={{ marginBottom: 28 }}>
            <MetaCaption text={caption} startFrame={captionStart} fontFamily={monoFont} />
          </div>

          <KineticHeadline lines={lines} startFrame={headlineStart} fontFamily={headlineFont} fontSize={headlineFontSize} />
        </div>

        <div style={{ position: "absolute", left: MARGIN_LEFT, bottom: 40 }}>
          <Timecode fontFamily={monoFont} startFrame={timecodeStart} />
        </div>
      </div>

      <ProductFrame startFrame={frameStart} exitStart={exitStart} exitEnd={exitEnd} />
    </AbsoluteFill>
  );
};

export const Intro: React.FC<SceneProps> = (props) => (
  <AbsoluteFill style={{ background: COLORS.bg }}>
    <IntroContent {...props} />
  </AbsoluteFill>
);
