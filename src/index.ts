import { Hono } from "hono";
import { Env, getLatest, getHistory, perGramTable, spread } from "./bnm";
import { QUESTIONS, runAgent, TraceStep } from "./agent";

const app = new Hono<{ Bindings: Env }>();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 502);
});

app.get("/api/latest", async (c) => {
  const day = await getLatest(c.env);
  c.header("Cache-Control", "public, max-age=300");
  return c.json({
    ...day,
    per_gram: perGramTable(day),
    spread_one_oz: spread(day.one_oz.buying, day.one_oz.selling),
  });
});

app.get("/api/history", async (c) => {
  const months = Number(c.req.query("months") ?? 3);
  const days = await getHistory(c.env, months);
  c.header("Cache-Control", "public, max-age=900");
  return c.json({ months, days });
});

app.get("/api/questions", (c) =>
  c.json(QUESTIONS.map(({ id, text }) => ({ id, text }))));

interface Answer {
  id: string; question: string; answer: string;
  mode: "agent" | "fallback"; model?: string; trace: TraceStep[];
  effective_date: string; note?: string;
}

// Only menu questions are accepted, and each answer is cached per BNM
// effective date, so the LLM runs at most once per question per business day.
app.post("/api/ask", async (c) => {
  const { id } = await c.req.json<{ id?: string }>().catch(() => ({ id: undefined }));
  const q = QUESTIONS.find((x) => x.id === id);
  if (!q) return c.json({ error: "unknown question" }, 400);

  const latest = await getLatest(c.env);
  const model = c.env.LLM_MODEL || "none";
  const key = `ask:${q.id}:${latest.date}:${model}`;
  const hit = await c.env.CACHE.get<Answer>(key, "json");
  if (hit) return c.json({ ...hit, cached: true });

  let out: Answer;
  let ttl = 24 * 3600;
  try {
    const { answer, trace } = await runAgent(c.env, q.text);
    out = { id: q.id, question: q.text, answer, mode: "agent", model, trace, effective_date: latest.date };
  } catch (e) {
    const reason = e instanceof Error ? e.message : String(e);
    out = {
      id: q.id, question: q.text, answer: await q.fallback(c.env), mode: "fallback", trace: [],
      effective_date: latest.date,
      note: reason === "LLM not configured" ? "LLM not configured; computed directly." : `Agent unavailable (${reason}); computed directly.`,
    };
    ttl = reason === "LLM not configured" ? 24 * 3600 : 10 * 60; // retry the agent soon after an outage
  }
  await c.env.CACHE.put(key, JSON.stringify(out), { expirationTtl: ttl });
  return c.json({ ...out, cached: false });
});

app.get("/api/*", (c) => c.json({ error: "not found" }, 404));

// Everything else is the static page in /public.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

export default app;
