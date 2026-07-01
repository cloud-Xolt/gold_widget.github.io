import { useState, useEffect, useCallback } from "react";

async function fetchGoldPrices() {
  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: "claude-sonnet-4-6",
      max_tokens: 1500,
      tools: [{ type: "web_search_20250305", name: "web_search" }],
      messages: [{
        role: "user",
        content: `Search for current gold prices AND recent price history. I need:
1. Shanghai Gold Exchange Au T+D current price CNY/gram + yesterday close
2. Spot gold XAU/USD current price USD/oz + yesterday close
3. For BOTH: ~8 intraday price points today (oldest→newest incl current), AND last 7 daily closing prices (oldest→newest incl today).
Return ONLY JSON:
{"hu":{"price":NUMBER,"prev":NUMBER,"intraday":[N,...],"daily":[N,...]},"xau":{"price":NUMBER,"prev":NUMBER,"intraday":[N,...],"daily":[N,...]}}
Real numbers. ONLY JSON, no markdown.`
      }],
    }),
  });
  const data = await res.json();
  const text = data.content.map(b => b.type === "text" ? b.text : "").filter(Boolean).join("");
  return JSON.parse(text.replace(/```json|```/g, "").trim());
}

function useTheme() {
  const [dark, setDark] = useState(() => window.matchMedia("(prefers-color-scheme: dark)").matches);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-color-scheme: dark)");
    const h = e => setDark(e.matches);
    mq.addEventListener("change", h);
    return () => mq.removeEventListener("change", h);
  }, []);
  return dark
    ? { bg: "rgba(28,28,30,0.78)", fg: "#fff", sub: "rgba(255,255,255,0.38)",
        sep: "rgba(255,255,255,0.05)", ts: "rgba(255,255,255,0.22)",
        border: "rgba(255,255,255,0.06)", shadow: "rgba(0,0,0,0.3)",
        up: "#FF453A", dn: "#30D158", flat: "rgba(255,255,255,0.3)",
        pill: "rgba(255,255,255,0.07)", pillAct: "rgba(255,255,255,0.16)", pillTxt: "rgba(255,255,255,0.45)" }
    : { bg: "rgba(255,255,255,0.72)", fg: "#1C1C1E", sub: "rgba(60,60,67,0.4)",
        sep: "rgba(60,60,67,0.08)", ts: "rgba(60,60,67,0.25)",
        border: "rgba(0,0,0,0.04)", shadow: "rgba(0,0,0,0.1)",
        up: "#FF3B30", dn: "#34C759", flat: "rgba(60,60,67,0.25)",
        pill: "rgba(0,0,0,0.04)", pillAct: "rgba(0,0,0,0.1)", pillTxt: "rgba(60,60,67,0.45)" };
}

function Spark({ points, color, w = 40, h = 16 }) {
  if (!points || points.length < 2) return null;
  const mn = Math.min(...points), mx = Math.max(...points), rng = mx - mn || 1;
  const p = 1.5;
  const pts = points.map((v, i) =>
    `${(i / (points.length - 1)) * w},${p + (1 - (v - mn) / rng) * (h - p * 2)}`
  ).join(" ");
  return (
    <svg width={w} height={h} viewBox={`0 0 ${w} ${h}`} style={{ display: "block", flexShrink: 0 }}>
      <polyline points={pts} fill="none" stroke={color} strokeWidth="1.2"
        strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function Row({ label, price, prev, unit, points, t }) {
  const diff = price != null && prev ? price - prev : null;
  const pct = diff != null && prev ? (diff / prev) * 100 : null;
  const up = diff > 0, dn = diff < 0;
  const c = up ? t.up : dn ? t.dn : t.flat;
  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "6px 0" }}>
      <span style={{ fontSize: 10, color: t.sub, fontWeight: 500, width: 40, flexShrink: 0 }}>{label}</span>
      <div style={{ display: "flex", alignItems: "center", gap: 4, flex: 1, justifyContent: "flex-end" }}>
        {price == null ? (
          <span style={{ fontSize: 15, color: t.flat, fontWeight: 600 }}>--</span>
        ) : (
          <>
            <span style={{ fontSize: 15, fontWeight: 700, color: t.fg, fontFeatureSettings: '"tnum"', letterSpacing: -0.5 }}>
              {price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
            </span>
            <span style={{ fontSize: 10, fontWeight: 600, color: c, fontFeatureSettings: '"tnum"', minWidth: 38, textAlign: "right" }}>
              {pct != null ? `${up ? "+" : ""}${pct.toFixed(2)}%` : ""}
            </span>
          </>
        )}
        <Spark points={points} color={c} />
      </div>
    </div>
  );
}

export default function W() {
  const t = useTheme();
  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(true);
  const [time, setTime] = useState(null);
  const [mode, setMode] = useState("intraday");

  const go = useCallback(async () => {
    try { const d = await fetchGoldPrices(); setData(d); setTime(new Date()); } catch {}
    finally { setLoading(false); }
  }, []);

  useEffect(() => { go(); const iv = setInterval(go, 60000); return () => clearInterval(iv); }, [go]);

  return (
    <div style={{ display: "flex", alignItems: "center", justifyContent: "center", minHeight: "100vh",
      fontFamily: '-apple-system, "SF Pro Text", "Helvetica Neue", sans-serif' }}>
      <div style={{
        width: 200, background: t.bg,
        backdropFilter: "blur(40px)", WebkitBackdropFilter: "blur(40px)",
        borderRadius: 16, padding: "8px 14px 7px",
        border: `0.5px solid ${t.border}`, boxShadow: `0 4px 24px ${t.shadow}`,
      }}>
        <Row label="沪金T+D" price={data?.hu?.price} prev={data?.hu?.prev} unit="¥/g" points={data?.hu?.[mode]} t={t} />
        <div style={{ height: 0.5, background: t.sep }} />
        <Row label="XAU/USD" price={data?.xau?.price} prev={data?.xau?.prev} unit="$/oz" points={data?.xau?.[mode]} t={t} />

        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center",
          marginTop: 4, paddingTop: 4, borderTop: `0.5px solid ${t.sep}` }}>
          <span style={{ fontSize: 9, color: t.ts, fontFeatureSettings: '"tnum"' }}>
            {loading ? "…" : time?.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" })}
          </span>
          <div style={{ display: "flex", background: t.pill, borderRadius: 5, padding: 1 }}>
            {["intraday", "daily"].map(m => (
              <button key={m} onClick={() => setMode(m)} style={{
                fontSize: 9, fontWeight: mode === m ? 600 : 400,
                color: mode === m ? t.fg : t.pillTxt,
                background: mode === m ? t.pillAct : "transparent",
                border: "none", borderRadius: 4, padding: "1.5px 6px",
                cursor: "pointer", fontFamily: "inherit", lineHeight: 1.4,
              }}>
                {m === "intraday" ? "分时" : "日K"}
              </button>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}
