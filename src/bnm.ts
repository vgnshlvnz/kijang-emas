// Bank Negara Malaysia Kijang Emas data, cached in KV.
// BNM publishes once per business day, so caching keeps us to a handful of
// upstream calls no matter how many visitors the page gets.

export interface Env {
  CACHE: KVNamespace;
  ASSETS: Fetcher;
  LLM_API_KEY?: string;
  LLM_BASE_URL?: string;
  LLM_MODEL?: string;
}

export interface Price { buying: number; selling: number }
export interface Day {
  date: string;
  one_oz: Price;
  half_oz?: Price;
  quarter_oz?: Price;
}

const BNM = "https://api.bnm.gov.my/public";
const HEADERS = {
  Accept: "application/vnd.BNM.API.v1+json",
  "User-Agent": "kijang-emas-demo/1.0",
};

export const TROY_OZ_G = 31.1034768;
export const COIN_GRAMS: Record<string, number> = {
  one_oz: TROY_OZ_G, half_oz: TROY_OZ_G / 2, quarter_oz: TROY_OZ_G / 4,
};
export const KIJANG_FINENESS = 0.9999;
export const PURITIES: Record<string, { factor: number; label: string }> = {
  "999.9": { factor: 0.9999, label: "24K (999.9)" },
  "916": { factor: 0.916, label: "22K (916)" },
  "750": { factor: 0.75, label: "18K (750)" },
};

const LATEST_TTL = 30 * 60;          // 30 min
const PAST_MONTH_TTL = 7 * 24 * 3600; // closed months rarely change

function price(p: any): Price | undefined {
  if (!p) return undefined;
  const buying = Number(p.buying), selling = Number(p.selling);
  return Number.isFinite(buying) && Number.isFinite(selling) ? { buying, selling } : undefined;
}

function toDay(d: any): Day | null {
  const one = price(d?.one_oz);
  if (!d?.effective_date || !one) return null;
  return { date: String(d.effective_date), one_oz: one,
           half_oz: price(d.half_oz), quarter_oz: price(d.quarter_oz) };
}

async function bnm(path: string): Promise<any | null> {
  const r = await fetch(BNM + path, { headers: HEADERS });
  if (r.status === 404) return null; // weekend, holiday or no data yet
  if (!r.ok) throw new Error(`BNM ${path} returned HTTP ${r.status}`);
  return r.json();
}

async function cached<T>(env: Env, key: string, ttl: number,
                         load: () => Promise<T | null>): Promise<T | null> {
  const hit = await env.CACHE.get<T>(key, "json");
  if (hit) return hit;
  const value = await load();
  if (value !== null) await env.CACHE.put(key, JSON.stringify(value), { expirationTtl: ttl });
  return value;
}

/** Malaysia (UTC+8) calendar date parts. */
export function myNow(): { y: number; m: number; iso: string } {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  return { y: d.getUTCFullYear(), m: d.getUTCMonth() + 1, iso: d.toISOString().slice(0, 10) };
}

export async function getLatest(env: Env): Promise<Day> {
  const day = await cached(env, "bnm:latest", LATEST_TTL, async () => toDay((await bnm("/kijang-emas"))?.data));
  if (!day) throw new Error("BNM returned no Kijang Emas data");
  return day;
}

export async function getMonth(env: Env, y: number, m: number): Promise<Day[]> {
  const now = myNow();
  const current = y === now.y && m === now.m;
  const days = await cached(env, `bnm:month:${y}-${m}`, current ? LATEST_TTL : PAST_MONTH_TTL,
    async () => {
      const body = await bnm(`/kijang-emas/year/${y}/month/${m}`);
      const rows = Array.isArray(body?.data) ? body.data : body?.data ? [body.data] : [];
      return rows.map(toDay).filter(Boolean) as Day[];
    });
  return days ?? [];
}

/** Last `months` calendar months including the current one, oldest first. */
export async function getHistory(env: Env, months: number): Promise<Day[]> {
  months = Math.min(Math.max(Math.trunc(months) || 1, 1), 12);
  const { y, m } = myNow();
  const wanted: Array<[number, number]> = [];
  for (let i = months - 1; i >= 0; i--) {
    const t = new Date(Date.UTC(y, m - 1 - i, 1));
    wanted.push([t.getUTCFullYear(), t.getUTCMonth() + 1]);
  }
  const chunks = await Promise.all(wanted.map(([yy, mm]) => getMonth(env, yy, mm)));
  const byDate = new Map<string, Day>();
  for (const d of chunks.flat()) byDate.set(d.date, d);
  return [...byDate.values()].sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------- maths ---

export function gramValue(coinPrice: number, coin = "one_oz", purity = "999.9", grams = 1): number {
  if (!(coin in COIN_GRAMS)) throw new Error(`coin must be one of ${Object.keys(COIN_GRAMS)}`);
  if (!(purity in PURITIES)) throw new Error(`purity must be one of ${Object.keys(PURITIES)}`);
  if (!(grams > 0)) throw new Error("grams must be positive");
  const perGramFine = coinPrice / (COIN_GRAMS[coin] * KIJANG_FINENESS);
  return round2(perGramFine * PURITIES[purity].factor * grams);
}

export function spread(buying: number, selling: number) {
  return { spread_myr: round2(selling - buying), spread_pct: round2(((selling - buying) / selling) * 100) };
}

export function seriesStats(days: Day[], side: "selling" | "buying" = "selling") {
  if (!days.length) throw new Error("no data in range");
  const pts = days.map((d) => ({ date: d.date, v: d.one_oz[side] }));
  const first = pts[0], last = pts[pts.length - 1];
  const min = pts.reduce((a, b) => (b.v < a.v ? b : a));
  const max = pts.reduce((a, b) => (b.v > a.v ? b : a));
  return {
    side, coin: "one_oz", trading_days: pts.length,
    from: first, to: last,
    change_myr: round2(last.v - first.v),
    change_pct: round2(((last.v - first.v) / first.v) * 100),
    low: min, high: max,
  };
}

// Explicit order: JS sorts integer-like keys ("750", "916") before "999.9".
const PURITY_ORDER = ["999.9", "916", "750"];

export function perGramTable(day: Day) {
  return PURITY_ORDER.map((purity) => ({
    purity, label: PURITIES[purity].label,
    selling_per_gram: gramValue(day.one_oz.selling, "one_oz", purity),
    buying_per_gram: gramValue(day.one_oz.buying, "one_oz", purity),
  }));
}

export const round2 = (n: number) => Math.round(n * 100) / 100;
