# Kijang Emas demo — Cloudflare Workers

A public demo page for the gold-price agent:

- today's BNM Kijang Emas prices (1 oz, ½ oz, ¼ oz)
- per-gram values for 24K, 22K and 18K
- a trend chart (1M, 3M, 6M, 1Y)
- a daily price list
- **"Ask the agent"**: a fixed menu of questions answered by an LLM through tool calls, with the tool trace shown.

Visitors can't type their own questions, so there's no prompt injection, no abuse of your API key, and the cost is predictable.

## How it works

```
browser ──► Worker (Hono)
             ├─ /            static page (public/index.html, Chart.js)
             ├─ /api/latest  BNM latest  ─┐
             ├─ /api/history BNM by month ├─ KV cache (30 min; closed months 7 days)
             ├─ /api/questions            │
             └─ /api/ask {id} ─► agent loop ─► LLM (NIM / vLLM, OpenAI-compatible)
                                   tools: get_latest_price, get_price_history,
                                          history_stats, gram_value, buy_sell_spread
```

- **Cost control:** each answer is cached in KV per question, per BNM effective date and per model. The LLM therefore runs at most **6 times per business day**, however many people visit.
- **Never broken:** every question has a deterministic fallback. With no model configured, a retired model (410) or an outage, the page still answers. It shows "Computed directly" instead of "Answered by agent", and retries the agent after 10 minutes.

## One-time setup

```bash
npm install
npx wrangler kv namespace create CACHE      # paste the printed id into wrangler.jsonc
```

Set the model in `wrangler.jsonc` → `vars.LLM_MODEL`. Use one that `find_models.py` marked **TOOLS OK**. Leave it empty to run without an LLM.

## Deploy (GitHub Actions, CI only)

Add these to the GitHub repo under **Settings → Secrets and variables → Actions**:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Token with *Workers Scripts: Edit* and *Workers KV Storage: Edit* |
| `CLOUDFLARE_ACCOUNT_ID` | Your account id |
| `LLM_API_KEY` | Your NVIDIA (or vLLM) key — pushed as a Worker secret on each deploy |

Push to `main`. The workflow typechecks, runs the smoke tests, then deploys.

## Local development

```bash
cp .dev.vars.example .dev.vars    # add key + model
npm run dev                       # http://localhost:8787
npm test                          # offline smoke tests (BNM and LLM mocked)
npm run typecheck
```

## Changing things

- **New question:** add an entry to `QUESTIONS` in `src/agent.ts`, with its text and a `fallback`.
- **New tool:** add an entry to `TOOLS` with a JSON schema and a `run` function.
- **Different LLM:** change `LLM_BASE_URL` / `LLM_MODEL` in `wrangler.jsonc`. Any OpenAI-compatible endpoint with tool calling works. That includes your vLLM server, if it's reachable from Cloudflare (for example through a Cloudflare Tunnel).

## After first deploy, check

1. `https://<worker>/api/latest` returns prices. If you get a 502 mentioning BNM, the BNM API may be refusing Cloudflare's IPs. The error body says which call failed.
2. Ask one question and confirm the badge says **Answered by agent**. If it says *Computed directly*, the note under the answer gives the reason (e.g. `LLM HTTP 410` means the model was retired).
