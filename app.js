/* GoldWidget PWA — vanilla JS, no build step.
 * Data sources (all client-side, no backend of our own):
 *   - XAU/USD spot price: gold-api.com (free, CORS-enabled, no key)
 *   - USD/CNY rate: exchangerate-api.com (free v4 endpoint, no key)
 *   - 沪金T+D (SGE Au(T+D), CNY/gram): best-effort via public CORS proxy in front of
 *     Sina's hq.sinajs.cn feed; if every proxy fails, falls back to an approximation
 *     derived from XAU/USD * USD/CNY (labelled "≈" in the UI so it's never presented
 *     as an exact SGE quote).
 */

const OZ_TO_GRAM = 31.1034768;
const STATE_KEY = "gw_state_v1";
const REFRESH_MS = 60000;
const FETCH_TIMEOUT_MS = 6000;
const MAX_INTRADAY_POINTS = 48;
const MAX_DAILY_POINTS = 7;

const SINA_PROXIES = [
  url => `https://api.allorigins.win/raw?url=${encodeURIComponent(url)}`,
  url => `https://corsproxy.io/?url=${encodeURIComponent(url)}`,
];

// ---------------------------------------------------------------- utils --

function todayStr(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

async function fetchWithTimeout(url, ms = FETCH_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const res = await fetch(url, { signal: ctrl.signal, cache: "no-store" });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res;
  } finally {
    clearTimeout(t);
  }
}

// --------------------------------------------------------- data sources --

async function fetchXau() {
  const res = await fetchWithTimeout("https://api.gold-api.com/price/XAU");
  const j = await res.json();
  const price = Number(j.price);
  if (!Number.isFinite(price)) throw new Error("bad xau payload");
  return price;
}

async function fetchUsdCny() {
  const res = await fetchWithTimeout("https://api.exchangerate-api.com/v4/latest/USD");
  const j = await res.json();
  const rate = Number(j?.rates?.CNY);
  if (!Number.isFinite(rate)) throw new Error("bad fx payload");
  return rate;
}

function parseSinaAutd(text) {
  const m = text.match(/hq_str_gds_AUTD="([^"]*)"/);
  if (!m || !m[1]) return null;
  const parts = m[1].split(",");
  const price = parseFloat(parts[0]);
  let prev = parts.length > 7 ? parseFloat(parts[7]) : NaN;
  if (!Number.isFinite(price)) return null;
  if (Number.isFinite(prev) && prev > 0) {
    const chg = Math.abs(price - prev) / prev;
    if (chg > 0.15) prev = NaN; // field misalignment guard, mirrors main.py
  }
  return { price, prev: Number.isFinite(prev) ? prev : null };
}

async function fetchHuReal() {
  const target = "https://hq.sinajs.cn/list=gds_AUTD";
  for (const build of SINA_PROXIES) {
    try {
      const res = await fetchWithTimeout(build(target), 4000);
      const text = await res.text();
      const parsed = parseSinaAutd(text);
      if (parsed) return parsed;
    } catch {
      // try next proxy
    }
  }
  return null;
}

/** Fallback when no live SGE quote is reachable: approximate CNY/gram from
 *  international spot gold + FX rate. Not an exact Au(T+D) print (ignores
 *  local premium/discount), so callers should mark it as approximate. */
function approxHuFromXau(xauPrice, usdCny) {
  return (xauPrice / OZ_TO_GRAM) * usdCny;
}

// ------------------------------------------------------------- history --

function loadState() {
  try {
    const raw = localStorage.getItem(STATE_KEY);
    if (raw) return JSON.parse(raw);
  } catch {}
  return null;
}

function saveState(state) {
  try {
    localStorage.setItem(STATE_KEY, JSON.stringify(state));
  } catch {}
}

function emptySeries() {
  return { intraday: [], daily: [], prevClose: null, approx: false };
}

function rollDayIfNeeded(state, today) {
  if (state.date === today) return state;
  for (const key of ["hu", "xau"]) {
    const s = state[key];
    const lastPrice = s.intraday.length ? s.intraday[s.intraday.length - 1] : null;
    if (lastPrice != null) {
      s.daily.push(lastPrice);
      if (s.daily.length > MAX_DAILY_POINTS) s.daily.shift();
      s.prevClose = lastPrice;
    }
    s.intraday = [];
  }
  state.date = today;
  return state;
}

function pushPoint(series, price) {
  series.intraday.push(price);
  if (series.intraday.length > MAX_INTRADAY_POINTS) series.intraday.shift();
}

function displayDaily(series, currentPrice) {
  // last (up to) 6 finalized closes + today's running price
  const past = series.daily.slice(-(MAX_DAILY_POINTS - 1));
  return [...past, currentPrice];
}

// ------------------------------------------------------------- render --

const els = {
  card: document.getElementById("card"),
  time: document.getElementById("time"),
  rowHu: document.getElementById("row-hu"),
  rowXau: document.getElementById("row-xau"),
  modeToggle: document.getElementById("mode-toggle"),
};

let mode = "intraday";
let lastState = null;
let lastPrices = null; // {hu:{price}, xau:{price}}
let usedApprox = false;
let offline = false;

function buildSparkPoints(points, w = 40, h = 16) {
  if (!points || points.length < 2) return "";
  const mn = Math.min(...points);
  const mx = Math.max(...points);
  const rng = mx - mn || 1;
  const p = 1.5;
  return points
    .map((v, i) => {
      const x = (i / (points.length - 1)) * w;
      const y = p + (1 - (v - mn) / rng) * (h - p * 2);
      return `${x},${y}`;
    })
    .join(" ");
}

function renderRow(rowEl, { price, prev, points, approx }) {
  const priceEl = rowEl.querySelector(".price");
  const pctEl = rowEl.querySelector(".pct");
  const sparkEl = rowEl.querySelector(".spark");

  if (price == null) {
    priceEl.textContent = "--";
    priceEl.classList.add("dim");
    pctEl.textContent = "";
    sparkEl.innerHTML = "";
    return;
  }

  priceEl.classList.remove("dim");
  priceEl.textContent = (approx ? "≈" : "") + price.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  });

  const diff = prev ? price - prev : null;
  const pct = diff != null && prev ? (diff / prev) * 100 : null;
  const up = diff > 0, dn = diff < 0;
  pctEl.className = "pct " + (up ? "up" : dn ? "dn" : "flat");
  pctEl.textContent = pct != null ? `${up ? "+" : ""}${pct.toFixed(2)}%` : "";

  const cls = up ? "up" : dn ? "dn" : "flat";
  const pts = buildSparkPoints(points);
  sparkEl.innerHTML = pts
    ? `<polyline class="${cls}" points="${pts}"></polyline>`
    : "";
}

function render() {
  if (!lastState) return;
  const s = lastState;
  const huPrice = lastPrices?.hu ?? null;
  const xauPrice = lastPrices?.xau ?? null;

  renderRow(els.rowHu, {
    price: huPrice,
    prev: s.hu.prevClose,
    points: mode === "intraday" ? s.hu.intraday : displayDaily(s.hu, huPrice ?? s.hu.intraday.at(-1)),
    approx: usedApprox,
  });
  renderRow(els.rowXau, {
    price: xauPrice,
    prev: s.xau.prevClose,
    points: mode === "intraday" ? s.xau.intraday : displayDaily(s.xau, xauPrice ?? s.xau.intraday.at(-1)),
    approx: false,
  });

  els.time.classList.toggle("offline", offline);
  els.time.textContent = new Date().toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

els.modeToggle.addEventListener("click", e => {
  const btn = e.target.closest(".pill-btn");
  if (!btn) return;
  mode = btn.dataset.mode;
  for (const b of els.modeToggle.querySelectorAll(".pill-btn")) {
    b.classList.toggle("active", b === btn);
  }
  render();
});

// --------------------------------------------------------------- flow --

async function refresh() {
  const today = todayStr();
  let state = loadState() || { date: today, hu: emptySeries(), xau: emptySeries() };
  state = rollDayIfNeeded(state, today);

  try {
    const [xauPrice, usdCny] = await Promise.all([fetchXau(), fetchUsdCny()]);
    let hu = await fetchHuReal();
    if (hu) {
      usedApprox = false;
    } else {
      hu = { price: approxHuFromXau(xauPrice, usdCny), prev: null };
      usedApprox = true;
    }

    pushPoint(state.hu, hu.price);
    pushPoint(state.xau, xauPrice);
    if (state.hu.prevClose == null && hu.prev != null) state.hu.prevClose = hu.prev;

    lastPrices = { hu: hu.price, xau: xauPrice };
    offline = false;
    saveState(state);
  } catch (err) {
    // network unavailable: fall back to last known cached values
    offline = true;
    lastPrices = {
      hu: state.hu.intraday.length ? state.hu.intraday.at(-1) : null,
      xau: state.xau.intraday.length ? state.xau.intraday.at(-1) : null,
    };
  }

  lastState = state;
  render();
}

function init() {
  refresh();
  setInterval(refresh, REFRESH_MS);
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") refresh();
  });

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => {
      navigator.serviceWorker.register("sw.js").catch(() => {});
    });
  }
}

init();
