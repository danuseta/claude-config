import React from "react";
import { interpolate, useCurrentFrame, useVideoConfig } from "remotion";
import { COLORS } from "./theme";

const pad = (n: number) => String(Math.max(0, n)).padStart(2, "0");

/**
 * A plain, ticking mm:ss:ff readout — the one piece of motion during the
 * hold phase. Meaningful (it's literally counting the runtime) rather
 * than decorative, and it scales to any hold length for free.
 */
export const Timecode: React.FC<{ fontFamily: string; startFrame?: number }> = ({ fontFamily, startFrame = 0 }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const opacity = interpolate(frame - startFrame, [0, 12], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  const totalFrames = Math.max(0, frame);
  const ff = totalFrames % fps;
  const totalSeconds = Math.floor(totalFrames / fps);
  const ss = totalSeconds % 60;
  const mm = Math.floor(totalSeconds / 60);

  return (
    <div
      style={{
        fontFamily,
        fontWeight: 500,
        fontSize: 18,
        letterSpacing: "0.08em",
        color: COLORS.dim,
        opacity: opacity * 0.8,
        fontVariantNumeric: "tabular-nums",
      }}
    >
      {pad(mm)}:{pad(ss)}:{pad(ff)}
    </div>
  );
};
