import React from "react";
import { AbsoluteFill, Easing, interpolate, useCurrentFrame } from "remotion";
import { COLORS, H, REVEAL_EASE, W } from "./theme";

/**
 * A restrained typographic baseline grid: a handful of hairlines that draw
 * on once at the very start (transform-origin left), then sit still. This
 * is the only texture the background gets — no blobs, no drift, no noise.
 */
export const Baselines: React.FC = () => {
  const frame = useCurrentFrame();
  const rows = 5;
  const gap = H / rows;

  return (
    <AbsoluteFill>
      <svg width={W} height={H} viewBox={`0 0 ${W} ${H}`} style={{ position: "absolute", inset: 0 }}>
        {Array.from({ length: rows - 1 }).map((_, i) => {
          const y = gap * (i + 1);
          const delay = i * 3;
          const p = interpolate(frame - delay, [0, 22], [0, 1], {
            extrapolateLeft: "clamp",
            extrapolateRight: "clamp",
            easing: Easing.bezier(...REVEAL_EASE),
          });
          return <line key={i} x1={0} y1={y} x2={W * p} y2={y} stroke={COLORS.hairline} strokeWidth={1} />;
        })}
      </svg>
    </AbsoluteFill>
  );
};
