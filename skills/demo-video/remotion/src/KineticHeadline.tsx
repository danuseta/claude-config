import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { COLORS, REVEAL_EASE } from "./theme";

/**
 * Editorial kinetic-type reveal: each line sits in an overflow-hidden mask
 * and slides up into view on a crisp deceleration curve. No spring, no
 * blur, no fade — the mask edge does all the work.
 */
export const KineticHeadline: React.FC<{
  lines: string[];
  startFrame?: number;
  fontFamily: string;
  fontSize: number;
  color?: string;
  staggerFrames?: number;
  durationFrames?: number;
}> = ({ lines, startFrame = 0, fontFamily, fontSize, color = COLORS.white, staggerFrames = 5, durationFrames = 16 }) => {
  const frame = useCurrentFrame();

  return (
    <div>
      {lines.map((line, i) => {
        const local = frame - startFrame - i * staggerFrames;
        const p = interpolate(local, [0, durationFrames], [0, 1], {
          extrapolateLeft: "clamp",
          extrapolateRight: "clamp",
          easing: Easing.bezier(...REVEAL_EASE),
        });
        const y = interpolate(p, [0, 1], [100, 0]);

        return (
          <div key={i} style={{ overflow: "hidden" }}>
            <div
              style={{
                transform: `translateY(${y}%)`,
                fontFamily,
                fontWeight: 800,
                fontSize,
                letterSpacing: "-0.03em",
                lineHeight: 1.04,
                color,
                whiteSpace: "nowrap",
              }}
            >
              {line}
            </div>
          </div>
        );
      })}
    </div>
  );
};
