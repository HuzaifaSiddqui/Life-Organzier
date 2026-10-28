import { readFileSync } from "node:fs";
import { parse } from "dotenv";
const env = parse(readFileSync(process.argv[2]));
const get = async (name: string, url: string, headers: Record<string, string>) => {
  try {
    const r = await fetch(url, { headers, signal: AbortSignal.timeout(15000) });
    const body = await r.json().catch(() => ({}));
    return { name, status: r.status, body };
  } catch (e) { return { name, status: 0, body: { error: e instanceof Error ? e.message : String(e) } }; }
};
const bearer = (k?: string) => ({ Authorization: `Bearer ${k ?? ""}` });
const out: Record<string, unknown> = {};
const ids = (b: any) => (b?.data ?? b?.models ?? (Array.isArray(b) ? b : [])).map((m: any) => m.id ?? m.name).filter(Boolean);
for (const [name, url, key] of [
  ["groq", "https://api.groq.com/openai/v1/models", env.GROQ_API_KEY],
  ["cerebras", "https://api.cerebras.ai/v1/models", env.CEREBRAS_API_KEY],
  ["together", "https://api.together.xyz/v1/models", env.TOGETHER_API_KEY],
  ["openrouter", "https://openrouter.ai/api/v1/models", env.OPENROUTER_API_KEY],
  ["deploy#1", "https://api-sf1-cdn.deploy.com/api/v1/models", env.DEPLOY_API_KEY_1],
  ["deploy#2", "https://api-sf1-cdn.deploy.com/api/v1/models", env.DEPLOY_API_KEY_2],
] as const) {
  const r = await get(name, url, bearer(key));
  const list = ids(r.body);
  out[name] = { status: r.status, count: list.length, error: r.status >= 400 || r.status === 0 ? JSON.stringify(r.body).slice(0, 160) : undefined };
  if (name === "openrouter") {
    const data = (r.body as any).data ?? [];
    const free = data.filter((m: any) => String(m.id).endsWith(":free"));
    (out[name] as any).freeIds = free.map((m: any) => `${m.id}|ctx ${m.context_length}|in:${(m.architecture?.input_modalities ?? []).join("+")}`);
  } else if (name === "together") {
    const data = Array.isArray(r.body) ? r.body : (r.body as any).data ?? [];
    (out[name] as any).sample = data.filter((m: any) => ["chat", "language", "embedding"].includes(m.type)).map((m: any) => `${m.id}|${m.type}|in$${m.pricing?.input ?? "?"}|out$${m.pricing?.output ?? "?"}`).slice(0, 400);
  } else (out[name] as any).ids = list;
}
const gm = await get("gemini", `https://generativelanguage.googleapis.com/v1beta/models?pageSize=200`, { "x-goog-api-key": env.GEMINI_API_KEY ?? "" });
out.gemini = { status: gm.status, ids: ((gm.body as any).models ?? []).map((m: any) => `${String(m.name).replace("models/", "")}|${(m.supportedGenerationMethods ?? []).join(",")}`) };
const k = await get("openrouter-key", "https://openrouter.ai/api/v1/key", bearer(env.OPENROUTER_API_KEY));
const kd = (k.body as any).data ?? {};
out["openrouter-key"] = { status: k.status, limit: kd.limit, usage: kd.usage, is_free_tier: kd.is_free_tier, rate_limit: kd.rate_limit, free_model_daily_requests: kd.free_model_daily_requests ?? kd.free_model_requests ?? null, keys: Object.keys(kd) };
console.log(JSON.stringify(out, null, 1));
