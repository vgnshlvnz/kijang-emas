// Offline smoke test: runs every route with BNM and the LLM mocked.
//   npm test
import assert from "node:assert/strict";
import app from "../src/index";

// ---------- in-memory KV
const store = new Map<string, string>();
const KV = {
  async get(k: string, type?: string) {
    const v = store.get(k);
    return v === undefined ? null : type === "json" ? JSON.parse(v) : v;
  },
  async put(k: string, v: string) { store.set(k, v); },
} as unknown as KVNamespace;

// ---------- fake BNM: one row per weekday, gently rising price
function bnmDay(date: string, i: number) {
  const sell = 14000 + i * 15;
  return { effective_date: date,
    one_oz: { buying: sell - 560, selling: sell },
    half_oz: { buying: (sell - 560) / 2, selling: sell / 2 + 40 },
    quarter_oz: { buying: (sell - 560) / 4, selling: sell / 4 + 30 } };
}
function monthRows(y: number, m: number) {
  const rows = [];
  for (let d = 1; d <= 28; d++) {
    const dt = new Date(Date.UTC(y, m - 1, d));
    if (dt.getUTCDay() % 6 === 0) continue;
    rows.push(bnmDay(dt.toISOString().slice(0, 10), y * 400 + m * 31 + d - 810000));
  }
  return rows;
}

let llmCalls = 0;
let llmMode: "ok" | "down" = "ok";
const realFetch = globalThis.fetch;
globalThis.fetch = (async (input: any, init?: any) => {
  const url = String(input instanceof Request ? input.url : input);
  const json = (b: unknown, status = 200) => new Response(JSON.stringify(b), { status, headers: { "content-type": "application/json" } });

  if (url.startsWith("https://api.bnm.gov.my/public/kijang-emas")) {
    assert.equal(new Headers(init?.headers).get("Accept"), "application/vnd.BNM.API.v1+json");
    const m = url.match(/year\/(\d+)\/month\/(\d+)/);
    if (m) return json({ data: monthRows(+m[1], +m[2]) });
    return json({ data: bnmDay("2026-11-04", 9999) });
  }

  if (url.endsWith("/chat/completions")) {
    llmCalls++;
    if (llmMode === "down") return new Response("Gone", { status: 410 });
    const body = JSON.parse(init.body);
    const toolMsgs = body.messages.filter((m: any) => m.role === "tool");
    // scripted model: fetch latest, convert, then answer
    if (toolMsgs.length === 0)
      return json({ choices: [{ message: { content: null, tool_calls: [
        { id: "a", type: "function", function: { name: "get_latest_price", arguments: "{}" } }] } }] });
    if (toolMsgs.length === 1) {
      const latest = JSON.parse(toolMsgs[0].content);
      return json({ choices: [{ message: { content: "", tool_calls: [
        { id: "b", type: "function", function: { name: "gram_value",
          arguments: JSON.stringify({ coin_price_myr: latest.one_oz.selling, purity: "916", grams: 10 }) } }] } }] });
    }
    return json({ choices: [{ message: { content: "<think>plan</think>10 g of 916 is about RM X on 2026-11-04." } }] });
  }
  return realFetch(input, init);
}) as typeof fetch;

const env = (model = "test/model") => ({
  CACHE: KV, ASSETS: { fetch: async () => new Response("<html>page</html>") } as unknown as Fetcher,
  LLM_API_KEY: "k", LLM_MODEL: model, LLM_BASE_URL: "https://llm.test/v1",
});
const call = async (path: string, e = env(), init?: RequestInit) => {
  const r = await app.request(path, init, e);
  return { status: r.status, body: r.headers.get("content-type")?.includes("json") ? await r.json<any>() : await r.text() };
};
const post = (id: string, e = env()) =>
  call("/api/ask", e, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ id }) });

// ---------- tests
let r = await call("/api/latest");
assert.equal(r.status, 200);
assert.equal(r.body.date, "2026-11-04");
assert.equal(r.body.per_gram.length, 3);
assert.ok(r.body.per_gram[1].selling_per_gram < r.body.per_gram[0].selling_per_gram, "22K cheaper than 24K");
assert.equal(r.body.spread_one_oz.spread_myr, 560);
console.log("ok  /api/latest", r.body.per_gram[0]);

r = await call("/api/history?months=6");
assert.equal(r.status, 200);
assert.ok(r.body.days.length > 80, "6 months of weekdays");
const dates = r.body.days.map((d: any) => d.date);
assert.deepEqual(dates, [...dates].sort(), "sorted oldest first");
console.log("ok  /api/history", r.body.days.length, "days", dates[0], "→", dates.at(-1));

r = await call("/api/questions");
assert.ok(r.body.length >= 5);
console.log("ok  /api/questions", r.body.map((q: any) => q.id).join(", "));

r = await post("ten_grams_916");
assert.equal(r.body.mode, "agent");
assert.equal(r.body.trace.length, 2);
assert.ok(!r.body.answer.includes("<think>"), "reasoning stripped");
console.log("ok  agent answer:", r.body.answer, "| trace:", r.body.trace.map((t: any) => t.tool).join(" → "));

const before = llmCalls;
r = await post("ten_grams_916");
assert.equal(r.body.cached, true);
assert.equal(llmCalls, before, "second ask served from cache, no LLM call");
console.log("ok  cached answer, LLM not called again");

llmMode = "down";
for (const id of ["today", "per_gram", "spread", "trend_30d", "trend_6m"]) {
  r = await post(id);
  assert.equal(r.status, 200, id);
  assert.equal(r.body.mode, "fallback", id);
  assert.match(r.body.note, /410/);
  console.log(`ok  fallback [${id}]`, r.body.answer.slice(0, 110) + "…");
}

r = await post("today", env(""));
assert.equal(r.body.mode, "fallback");
assert.match(r.body.note, /not configured/);
console.log("ok  no LLM configured → computed directly");

r = await post("drop table");
assert.equal(r.status, 400);
console.log("ok  free-form / unknown questions rejected");

r = await call("/");
assert.equal(r.body, "<html>page</html>");
console.log("ok  static page served\n\nall smoke tests passed");
