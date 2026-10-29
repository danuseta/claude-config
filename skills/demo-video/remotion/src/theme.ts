import type { CSSProperties } from "react";

// Restrained, single-accent editorial palette. No gradients, no secondary hue.
export const COLORS = {
  bg: "#0B0B12",
  white: "#FFFFFF",
  dim: "rgba(255,255,255,0.52)",
  faint: "rgba(255,255,255,0.14)",
  hairline: "rgba(255,255,255,0.07)",
  accent: "#6546EC",
} as const;

export const FPS = 30;
export const W = 1920;
export const H = 1080;

// Fallback lengths when no `dur` prop / narration length is known yet.
export const INTRO_FALLBACK_SECONDS = 3.5;
export const OUTRO_FALLBACK_SECONDS = 3;

// Phase budget: entrance animation always plays in the first ~2.5s, the
// exit/hand-off animation always plays in the final ~0.6s, and everything
// in between is a quiet hold (a ticking timecode only — no decoration).
export const ENTRANCE_SECONDS = 2.5;
export const EXIT_SECONDS = 0.6;

// Reserved band at the bottom of the frame for karaoke-style subtitles that
// get composited on top of the intro/outro elsewhere. Content should not
// be placed below this line.
export const SUBTITLE_SAFE_BOTTOM = 180;

// Shared editorial grid: everything hangs off a left margin, no centering.
export const MARGIN_LEFT = 168;
export const MARGIN_RIGHT = 168;

// The kinetic-reveal easing specified for headline lines: a crisp,
// confident deceleration — no bounce, no blur.
export const REVEAL_EASE = [0.16, 1, 0.3, 1] as const;
// A decisive ease-in, used for the exit hand-off.
export const EXIT_EASE = [0.7, 0, 0.84, 0] as const;

export type SceneProps = {
  ticket: string;
  title: string;
  subtitle?: string;
  /** Total duration in seconds. Drives calculateMetadata. */
  dur?: number;
};

export const DEFAULT_INTRO_PROPS: SceneProps = {
  ticket: "QRD-0000",
  title: "Judul fitur",
  subtitle: "Demo fitur",
  dur: INTRO_FALLBACK_SECONDS,
};

export const DEFAULT_OUTRO_PROPS: SceneProps = {
  ticket: "QRD-0000",
  title: "Judul fitur",
  subtitle: undefined,
  dur: OUTRO_FALLBACK_SECONDS,
};

/** Shared style for the content column: leaves the bottom safe zone clear
 * for karaoke subtitles composited on top later. */
export const safeContentStyle: CSSProperties = {
  position: "absolute",
  top: 0,
  left: 0,
  right: 0,
  bottom: SUBTITLE_SAFE_BOTTOM,
};

/** Greedy word-wrap by an estimated character budget — no DOM measuring,
 * just enough to keep an editorial headline from running off the column. */
export const wrapHeadline = (text: string, maxCharsPerLine: number): string[] => {
  const words = text.split(" ");
  const lines: string[] = [];
  let current = "";
  for (const word of words) {
    const next = current ? `${current} ${word}` : word;
    if (next.length > maxCharsPerLine && current) {
      lines.push(current);
      current = word;
    } else {
      current = next;
    }
  }
  if (current) lines.push(current);
  return lines;
};
