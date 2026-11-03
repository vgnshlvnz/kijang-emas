// The agent: a fixed menu of questions, answered by an LLM that calls tools.
// Every question also has a deterministic fallback, so the demo still works
// with no API key, a retired model, or an LLM outage.

import {
  Env, Day, getLatest, getHistory, gramValue, spread, seriesStats, perGramTable, COIN_GRAMS, PURITIES,
} from "./bnm";

// ---------------------------------------------------------------- tools ---

type Tool = {
  schema: { name: string; description: string; parameters: object };
  run: (env: Env, args: any) => Promise<unknown> | unknown;
};

const compactDays = (days: Day[]) =>
  days.map((d) => ({ date: d.date, buy: d.one_oz.buying, sell: d.one_oz.selling }));

export const TOOLS: Record<string, Tool> = {
  get_latest_price: {
    schema: {
      name: "get_latest_price",
      description: "Latest BNM Kijang Emas buying/selling prices (MYR) for 1 oz, 1/2 oz and 1/4 oz coins, with the effective date.",
      parameters: { type: "object", properties: {} },
    },
    run: (env) => getLatest(env),
  },
  get_price_history: {
    schema: {
      name: "get_price_history",
      description: "Daily 1 oz Kijang Emas buy/sell prices (MYR) for the last N calendar months including this one.",
      parameters: {
        type: "object",
        properties: { months: { type: "integer", minimum: 1, maximum: 12 } },
        required: ["months"],
      },
    },
    run: async (env, a) => compactDays(await getHistory(env, a.months)),
  },
  history_stats: {
    schema: {
      name: "history_stats",
      description: "Change, high and low of the 1 oz price over the last N months. Use instead of computing trends yourself.",
      parameters: {
        type: "object",
        properties: {
          months: { type: "integer", minimum: 1, maximum: 12 },
          side: { type: "string", enum: ["selling", "buying"] },
        },
        required: ["months"],
      },
    },
    run: async (env, a) => seriesStats(await getHistory(env, a.months), a.side ?? "selling"),
  },
  gram_value: {
    schema: {
      name: "gram_value",
      description: "Convert a Kijang Emas coin price (MYR) into the value of N grams of gold at a purity. Use for every per-gram or 22K/18K number.",
      parameters: {
        type: "object",
        properties: {
          coin_price_myr: { type: "number" },
          coin: { type: "string", enum: Object.keys(COIN_GRAMS) },
          purity: { type: "string", enum: Object.keys(PURITIES), description: "999.9 = 24K, 916 = 22K, 750 = 18K" },
          grams: { type: "number" },
        },
        required: ["coin_price_myr"],
      },
    },
    run: (_env, a) => ({ myr: gramValue(a.coin_price_myr, a.coin, a.purity, a.grams ?? 1) }),
  },
  buy_sell_spread: {
    schema: {
      name: "buy_sell_spread",
      description: "Gap between BNM selling and buying prices, in MYR and percent.",
      parameters: {
        type: "object",
        properties: { buying_myr: { type: "number" }, selling_myr: { type: "number" } },
        required: ["buying_myr", "selling_myr"],
      },
    },
    run: (_env, a) => spread(a.buying_myr, a.selling_myr),
  },
};

const SYSTEM = `You answer questions about Malaysian gold prices using Bank Negara Malaysia (BNM) Kijang Emas data.
Rules:
- Never guess prices: fetch them with tools.
- Never do arithmetic yourself: use gram_value, buy_sell_spread and history_stats for every derived number.
- BNM "selling" is what the public pays to buy; "buying" is what BNM pays the public.
- 24K = 999.9, 22K = 916, 18K = 750.
- Mention the effective date. Use RM with two decimals. Answer in 2-5 short sentences, plain text, no markdown tables.`;

// ------------------------------------------------------------ questions ---

const rm = (n: number) => "RM " + n.toLocaleString("en-MY", { minimumFractionDigits: 2, maximumFractionDigits: 2 });

export const QUESTIONS: Array<{ id: string; text: string; fallback: (env: Env) => Promise<string> }> = [
  {
    id: "today",
    text: "What is today's Kijang Emas price?",
    fallback: async (env) => {
      const d = await getLatest(env);
      return `On ${d.date}, BNM sells a 1 oz Kijang Emas at ${rm(d.one_oz.selling)} and buys it back at ${rm(d.one_oz.buying)}.` +
        (d.half_oz ? ` 1/2 oz: ${rm(d.half_oz.selling)} / ${rm(d.half_oz.buying)}.` : "") +
        (d.quarter_oz ? ` 1/4 oz: ${rm(d.quarter_oz.selling)} / ${rm(d.quarter_oz.buying)}.` : "");
    },
  },
  {
    id: "per_gram",
    text: "How much is 1 gram of 24K, 22K and 18K gold today?",
    fallback: async (env) => {
      const d = await getLatest(env);
      const rows = perGramTable(d).map((r) => `${r.label}: ${rm(r.selling_per_gram)}`).join(", ");
      return `Based on BNM's 1 oz selling price on ${d.date}, one gram works out to ${rows}. Jewellery shops add workmanship on top.`;
    },
  },
  {
    id: "ten_grams_916",
    text: "How much is 10 grams of 916 (22K) gold?",
    fallback: async (env) => {
      const d = await getLatest(env);
      return `At BNM's ${d.date} selling price, 10 g of 916 gold is worth about ${rm(gramValue(d.one_oz.selling, "one_oz", "916", 10))} ` +
        `in raw metal value (${rm(gramValue(d.one_oz.buying, "one_oz", "916", 10))} at the buying price).`;
    },
  },
  {
    id: "spread",
    text: "What is BNM's buy/sell spread for a 1 oz coin?",
    fallback: async (env) => {
      const d = await getLatest(env);
      const s = spread(d.one_oz.buying, d.one_oz.selling);
      return `On ${d.date}, the gap between BNM's selling (${rm(d.one_oz.selling)}) and buying (${rm(d.one_oz.buying)}) price is ${rm(s.spread_myr)}, ` +
        `or ${s.spread_pct}% of the selling price. That is roughly what you lose if you buy and sell back the same day.`;
    },
  },
  {
    id: "trend_30d",
    text: "How has the 1 oz price moved this month and last month?",
    fallback: async (env) => {
      const s = seriesStats(await getHistory(env, 2));
      const dir = s.change_myr >= 0 ? "risen" : "fallen";
      return `From ${s.from.date} to ${s.to.date} (${s.trading_days} trading days), the 1 oz selling price has ${dir} by ` +
        `${rm(Math.abs(s.change_myr))} (${s.change_pct}%), from ${rm(s.from.v)} to ${rm(s.to.v)}. ` +
        `The high was ${rm(s.high.v)} on ${s.high.date} and the low ${rm(s.low.v)} on ${s.low.date}.`;
    },
  },
  {
    id: "trend_6m",
    text: "What were the highest and lowest prices in the last 6 months?",
    fallback: async (env) => {
      const s = seriesStats(await getHistory(env, 6));
      return `Over ${s.trading_days} trading days since ${s.from.date}, the 1 oz selling price peaked at ${rm(s.high.v)} on ${s.high.date} ` +
        `and bottomed at ${rm(s.low.v)} on ${s.low.date}. It is now ${rm(s.to.v)} (${s.change_pct >= 0 ? "+" : ""}${s.change_pct}% over the period).`;
    },
  },
];

// --------------------------------------------------------------- loop ---

export interface TraceStep { tool: string; args: unknown; result: unknown }

const MAX_STEPS = 8;

function clip(v: unknown): unknown {
  const s = JSON.stringify(v);
  return s.length > 600 ? s.slice(0, 600) + "…" : v;
}

/** Strip reasoning blocks some models (e.g. Nemotron, Qwen) put in content. */
const clean = (s: string | null | undefined) =>
  (s ?? "").replace(/<think>[\s\S]*?<\/think>/g, "").trim();

export async function runAgent(env: Env, question: string): Promise<{ answer: string; trace: TraceStep[] }> {
  const base = (env.LLM_BASE_URL || "https://integrate.api.nvidia.com/v1").replace(/\/$/, "");
  const model = env.LLM_MODEL;
  if (!env.LLM_API_KEY || !model) throw new Error("LLM not configured");

  const tools = Object.values(TOOLS).map((t) => ({ type: "function", function: t.schema }));
  const messages: any[] = [{ role: "system", content: SYSTEM }, { role: "user", content: question }];
  const trace: TraceStep[] = [];

  for (let step = 0; step < MAX_STEPS; step++) {
    const r = await fetch(`${base}/chat/completions`, {
      method: "POST",
      headers: { Authorization: `Bearer ${env.LLM_API_KEY}`, "Content-Type": "application/json" },
      body: JSON.stringify({ model, messages, tools, tool_choice: "auto", temperature: 0, max_tokens: 1200 }),
    });
    if (!r.ok) throw new Error(`LLM HTTP ${r.status}: ${(await r.text()).slice(0, 160)}`);
    const msg = (await r.json<any>()).choices?.[0]?.message;
    if (!msg) throw new Error("LLM returned no message");

    if (!msg.tool_calls?.length) {
      const answer = clean(msg.content);
      if (!answer) throw new Error("LLM returned an empty answer");
      return { answer, trace };
    }

    messages.push({ role: "assistant", content: msg.content ?? "", tool_calls: msg.tool_calls });
    for (const tc of msg.tool_calls) {
      const name = tc.function?.name;
      let args: any = {};
      let result: unknown;
      try {
        args = JSON.parse(tc.function?.arguments || "{}");
        const tool = TOOLS[name];
        result = tool ? await tool.run(env, args) : { error: `unknown tool ${name}` };
      } catch (e) {
        result = { error: e instanceof Error ? e.message : String(e) }; // the model sees errors and can recover
      }
      trace.push({ tool: name, args, result: clip(result) });
      messages.push({ role: "tool", tool_call_id: tc.id, content: JSON.stringify(result) });
    }
  }
  throw new Error("agent hit the step limit");
}
