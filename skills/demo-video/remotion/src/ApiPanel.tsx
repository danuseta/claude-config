import { interpolate } from "remotion";

export type ApiRow = { k: string; v: string };
export type ApiCall = { at: number; method: string; path: string; body: string | null; status: number; rows: ApiRow[] };
export type ApiHighlight = { key: string; from: number; to: number };
export type ApiEntry = { from: number; to: number; calls: ApiCall[]; hl: ApiHighlight[]; label?: string };
export type CompareEntry = {
  from: number;
  to: number;
  version: number;
  path: string;
  storagePath: string;
  bytes: number;
  identical: boolean;
  text: string;
  label?: string;
};

const ACCENT = "#6546EC";
const INK = "#E8EBF0";
const MUTED = "#8B93A3";
const LINE = "#262B36";
const PANEL = "#12151D";
const MONO = "'JetBrains Mono', 'Cascadia Code', Consolas, monospace";

const STATUS_TEXT: Record<number, string> = { 200: "OK", 201: "Created", 409: "Conflict", 422: "Unprocessable" };
const ROW_KEY: Record<string, string> = { revision: "data.revision" };

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

const glow = (t: number, windows: ApiHighlight[], key: string) =>
  Math.max(
    0,
    ...windows
      .filter((w) => w.key === key)
      .map((w) => Math.min(interpolate(t, [w.from, w.from + 0.25], [0, 1], clamp), interpolate(t, [w.to, w.to + 0.35], [1, 0], clamp)))
  );

const Marked: React.FC<{ on: number; children: React.ReactNode; pad?: string }> = ({ on, children, pad = "10px 14px" }) => (
  <div
    style={{
      position: "relative",
      padding: pad,
      borderRadius: 8,
      background: `rgba(101,70,236,${0.2 * on})`,
      boxShadow: `inset 3px 0 0 rgba(101,70,236,${on})`,
    }}
  >
    {children}
  </div>
);

const CallCard: React.FC<{ call: ApiCall; t: number; hl: ApiHighlight[]; first: boolean; compact?: boolean }> = ({ call, t, hl, first, compact = false }) => {
  const enter = interpolate(t, [call.at, call.at + 0.45], [0, 1], { ...clamp, easing: (x) => 1 - Math.pow(1 - x, 3) });
  const ok = call.status < 400;
  return (
    <div
      style={{
        opacity: enter,
        transform: `translateY(${(1 - enter) * 18}px)`,
        background: PANEL,
        border: `1px solid ${LINE}`,
        borderRadius: 14,
        padding: compact ? "14px 20px" : "22px 24px",
        marginTop: first ? 0 : compact ? 12 : 18,
        fontFamily: MONO,
        color: INK,
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
        <span
          style={{
            fontSize: 17,
            fontWeight: 700,
            letterSpacing: "0.08em",
            color: "#fff",
            background: ACCENT,
            borderRadius: 6,
            padding: "4px 10px",
          }}
        >
          {call.method}
        </span>
        <span style={{ fontSize: 20, color: INK, wordBreak: "break-all" }}>{call.path}</span>
      </div>
      {call.body && (
        <Marked on={glow(t, hl, "request")} pad="8px 12px">
          <div style={{ marginTop: 12, fontSize: 19, color: MUTED }}>
            body <span style={{ color: INK }}>{call.body}</span>
          </div>
        </Marked>
      )}
      <div style={{ height: 1, background: LINE, margin: compact ? "10px 0 6px" : "16px 0 12px" }} />
      <Marked on={first || call.status >= 400 ? glow(t, hl, "status") : 0} pad="6px 12px">
        <div style={{ display: "flex", alignItems: "baseline", gap: 14 }}>
          <span style={{ width: 12, height: 12, borderRadius: 6, background: ok ? "#4ADE80" : "#F87171", alignSelf: "center" }} />
          <span style={{ fontSize: compact ? 30 : 44, fontWeight: 700, letterSpacing: "-0.02em" }}>{call.status}</span>
          <span style={{ fontSize: 20, color: MUTED }}>{STATUS_TEXT[call.status] ?? ""}</span>
        </div>
      </Marked>
      <div style={{ marginTop: 8 }}>
        {call.rows.map((row) => {
          const key = Object.keys(ROW_KEY).find((k) => ROW_KEY[k] === row.k) ?? row.k;
          return (
            <Marked key={row.k} on={glow(t, hl, key)} pad="8px 12px">
              <div style={{ display: "grid", gridTemplateColumns: "190px 1fr", gap: 12, alignItems: "baseline" }}>
                <span style={{ fontSize: 18, color: MUTED }}>{row.k}</span>
                <span style={{ fontSize: 22, color: INK, whiteSpace: "pre-wrap", lineHeight: 1.35 }}>{row.v}</span>
              </div>
            </Marked>
          );
        })}
      </div>
    </div>
  );
};

export const ApiPanel: React.FC<{ entry: ApiEntry; t: number }> = ({ entry, t }) => (
  <div>
    <div style={{ fontFamily: MONO, fontSize: 15, letterSpacing: "0.22em", color: MUTED, marginBottom: 14 }}>{entry.label ?? "API"}</div>
    {entry.calls
      .filter((call) => t >= call.at - 0.05)
      .map((call, i) => (
        <CallCard key={`${call.path}-${i}`} call={call} t={t} hl={entry.hl} first={i === 0} compact={entry.calls.length >= 3} />
      ))}
  </div>
);

export const ComparePanel: React.FC<{ entry: CompareEntry; t: number }> = ({ entry, t }) => {
  const verdict = interpolate(t, [entry.from + 2.2, entry.from + 2.7], [0, 1], clamp);
  return (
    <div style={{ fontFamily: MONO, color: INK }}>
      <div style={{ fontSize: 15, letterSpacing: "0.22em", color: MUTED, marginBottom: 14 }}>{entry.label ?? `VERSI ${entry.version}`}</div>
      <div style={{ background: PANEL, border: `1px solid ${LINE}`, borderRadius: 14, padding: "20px 22px" }}>
        <div style={{ display: "flex", alignItems: "center", gap: 12 }}>
          <span style={{ fontSize: 17, fontWeight: 700, color: "#fff", background: ACCENT, borderRadius: 6, padding: "4px 10px" }}>
            {entry.path}
          </span>
          <span style={{ fontSize: 15, color: MUTED, wordBreak: "break-all" }}>{entry.storagePath}</span>
        </div>
        <pre
          style={{
            margin: "16px 0 0",
            fontFamily: MONO,
            fontSize: 17,
            lineHeight: 1.5,
            color: INK,
            whiteSpace: "pre-wrap",
            wordBreak: "break-word",
            background: "#0B0D13",
            border: `1px solid ${LINE}`,
            borderRadius: 10,
            padding: "14px 16px",
          }}
        >
          {entry.text}
        </pre>
      </div>
      <div
        style={{
          marginTop: 16,
          opacity: verdict,
          display: "flex",
          alignItems: "center",
          gap: 12,
          fontSize: 22,
          padding: "12px 16px",
          borderRadius: 10,
          background: "rgba(101,70,236,0.18)",
          boxShadow: `inset 3px 0 0 ${ACCENT}`,
        }}
      >
        <span style={{ fontWeight: 700 }}>{entry.identical ? "Identik dengan Preview" : "Beda dengan Preview"}</span>
        <span style={{ color: MUTED }}>· {entry.bytes} bytes</span>
      </div>
    </div>
  );
};
