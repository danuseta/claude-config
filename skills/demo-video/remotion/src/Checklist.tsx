import { interpolate } from "remotion";

export type ChecklistRow = { ac: string; contract: string; evidence: string; line?: number; partial?: boolean };
export type ChecklistEntry = {
  from: number;
  to: number;
  lines?: number[];
  title: string;
  rows: ChecklistRow[];
  footer?: { title: string; items: string[] };
  fadeOutEnd?: number;
};

const ACCENT = "#6546EC";
const INK = "#E8EBF0";
const MUTED = "#8B93A3";
const LINE = "#262B36";
const MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";
const SANS = "Inter, 'Segoe UI', sans-serif";
const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

export const Checklist: React.FC<{ entry: ChecklistEntry; t: number }> = ({ entry, t }) => {
  const fadeEnd = entry.fadeOutEnd ?? entry.to + 0.4;
  const enter = Math.min(
    interpolate(t, [entry.from - 0.4, entry.from + 0.1], [0, 1], clamp),
    interpolate(t, [fadeEnd - 1, fadeEnd], [1, 0], clamp)
  );
  const lines = entry.lines && entry.lines.length ? entry.lines : [entry.from];
  const lineOf = (i: number) =>
    entry.rows[i].line ?? (entry.lines && entry.lines.length > 1 ? Math.min(lines.length - 1, 1 + Math.floor((i * (lines.length - 1)) / entry.rows.length)) : 0);
  const byLine = new Map<number, number[]>();
  entry.rows.forEach((_, i) => byLine.set(lineOf(i), [...(byLine.get(lineOf(i)) ?? []), i]));
  const tickAt = (i: number) => {
    const line = lineOf(i);
    const start = lines[line] ?? entry.from;
    const end = lines[line + 1] ?? entry.to;
    const group = byLine.get(line) ?? [i];
    const slot = (end - start) / (group.length + 0.5);
    return start + 0.4 + slot * group.indexOf(i);
  };
  const lastLine = lines[lines.length - 1] ?? entry.from;
  const footerOn = interpolate(t, [lastLine + 1, lastLine + 1.5], [0, 1], clamp);
  const cols = "56px 1.35fr 0.62fr 1.2fr 64px";
  return (
    <div
      style={{
        position: "absolute",
        inset: 0,
        background: "#0B0B12",
        opacity: enter,
        padding: "56px 96px 0",
        fontFamily: SANS,
        color: INK,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 16, fontFamily: MONO, fontSize: 18, letterSpacing: "0.22em", color: MUTED }}>
        <span style={{ width: 44, height: 2, background: ACCENT, display: "inline-block" }} />
        {entry.title}
      </div>
      <div style={{ marginTop: 22, border: `1px solid ${LINE}`, borderRadius: 14, overflow: "hidden" }}>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: cols,
            background: "#12151D",
            fontFamily: MONO,
            fontSize: 17,
            letterSpacing: "0.12em",
            color: MUTED,
            textTransform: "uppercase",
          }}
        >
          {["#", "AC tiket", "Kontrak S24", "Implementasi · bukti", "✓"].map((h) => (
            <div key={h} style={{ padding: "14px 18px" }}>
              {h}
            </div>
          ))}
        </div>
        {entry.rows.map((row, i) => {
          const at = tickAt(i);
          const done = interpolate(t, [at, at + 0.3], [0, 1], clamp);
          const tick = row.partial ? 0 : done;
          const flash = Math.min(interpolate(t, [at, at + 0.3], [0, 1], clamp), interpolate(t, [at + 0.9, at + 1.6], [1, 0], clamp));
          return (
            <div
              key={i}
              style={{
                display: "grid",
                gridTemplateColumns: cols,
                alignItems: "center",
                borderTop: `1px solid ${LINE}`,
                background: `rgba(101,70,236,${0.16 * flash})`,
                boxShadow: `inset 3px 0 0 rgba(101,70,236,${done})`,
              }}
            >
              <div style={{ padding: "10px 18px", fontFamily: MONO, fontSize: 20, color: MUTED }}>{i + 1}</div>
              <div style={{ padding: "10px 18px", fontSize: 23, fontWeight: 600, opacity: 0.55 + 0.45 * done }}>{row.ac}</div>
              <div style={{ padding: "10px 18px", fontFamily: MONO, fontSize: 19, color: MUTED }}>{row.contract}</div>
              <div style={{ padding: "10px 18px", fontFamily: MONO, fontSize: 19, color: INK, opacity: 0.5 + 0.5 * done }}>{row.evidence}</div>
              <div style={{ padding: "10px 18px", display: "flex", justifyContent: "center" }}>
                <span
                  style={{
                    width: 30,
                    height: 30,
                    borderRadius: 7,
                    border: `2px solid ${tick > 0.5 ? ACCENT : LINE}`,
                    background: `rgba(101,70,236,${tick})`,
                    color: "#fff",
                    fontSize: 20,
                    fontWeight: 800,
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    transform: `scale(${0.8 + 0.2 * tick})`,
                  }}
                >
                  {tick > 0.5 ? "✓" : ""}
                </span>
              </div>
            </div>
          );
        })}
      </div>
      {entry.footer && (
      <div
        style={{
          marginTop: 18,
          opacity: footerOn,
          transform: `translateY(${(1 - footerOn) * 10}px)`,
          display: "flex",
          alignItems: "baseline",
          gap: 22,
          padding: "14px 20px",
          border: `1px solid ${LINE}`,
          borderRadius: 12,
          background: "#12151D",
          boxShadow: `inset 3px 0 0 ${ACCENT}`,
        }}
      >
        <span style={{ fontSize: 20, fontWeight: 700, whiteSpace: "nowrap" }}>{entry.footer.title}</span>
        <span style={{ fontFamily: MONO, fontSize: 18, color: MUTED }}>{entry.footer.items.join("   ·   ")}</span>
      </div>
      )}
    </div>
  );
};
