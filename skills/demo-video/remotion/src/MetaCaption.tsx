import React from "react";
import { Easing, interpolate, useCurrentFrame } from "remotion";
import { COLORS, REVEAL_EASE } from "./theme";

/**
 * Small monospace metadata caption — ticket key plus an optional label —
 * preceded by a thin accent rule that draws in from zero width. This
 * stands in for a badge/pill: it reads as a caption, not a decoration.
 */
export const MetaCaption: React.FC<{
  text: string;
  startFrame?: number;
  fontFamily: string;
  fontSize?: number;
  ruleWidth?: number;
}> = ({ text, startFrame = 0, fontFamily, fontSize = 21, ruleWidth = 32 }) => {
  const frame = useCurrentFrame();
  const local = frame - startFrame;

  const draw = interpolate(local, [0, 14], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
    easing: Easing.bezier(...REVEAL_EASE),
  });
  const textOpacity = interpolate(local, [4, 16], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
      <div
        style={{
          width: ruleWidth * draw,
          height: 1,
          background: COLORS.accent,
          flexShrink: 0,
        }}
      />
      <span
        style={{
          fontFamily,
          fontWeight: 500,
          fontSize,
          letterSpacing: "0.14em",
          textTransform: "uppercase",
          color: COLORS.dim,
          opacity: textOpacity,
          whiteSpace: "nowrap",
        }}
      >
        {text}
      </span>
    </div>
  );
};
