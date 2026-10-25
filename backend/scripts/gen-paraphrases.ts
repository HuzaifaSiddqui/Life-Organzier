/**
 * `npm run paraphrases`: asks the local model (backend/.env) for 20 paraphrases per command, in English and in
 * Roman Urdu, for the 10 most-used commands, and writes them to tests/eval/review/paraphrases-review.json with
 * `approved: false`. Nothing enters the bank until a person sets `approved: true` (and fixes `command` if needed)
 * and runs `npm run bank:approve`.
 *
 * Most-used: the rules' command for the user messages in the development database (a local usage count); without
 * a database, how often each command appears in the bank. `-- --top 10 --per 20` change the numbers.
 */
import "dotenv/config";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { z } from "zod";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(root, "tests/eval/review/paraphrases-review.json");
const arg = (name: string, d: number) => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? Number(process.argv[i + 1]) || d : d;
};
const TOP = arg("top", 10);
const PER = arg("per", 20);

const { getAi } = await import("../src/ai/llm.js");
const { classify, getCommand, parseCtx } = await import("../src/modules/assistant/commands/registry.js");
const { loadBank } = await import("../src/modules/assistant/commands/neighbours.js");

async function mostUsed(): Promise<string[]> {
  const counts = new Map<string, number>();
  try {
    const { prisma } = await import("../src/config/db.js");
    const ctx = parseCtx({ now: new Date(), tz: "Asia/Karachi" });
    const msgs = await prisma.conversationMessage.findMany({ where: { role: "USER" }, select: { content: true }, take: 5000, orderBy: { createdAt: "desc" } });
    for (const m of msgs) {
      const c = classify(m.content, ctx).command;
      if (getCommand(c)) counts.set(c, (counts.get(c) ?? 0) + 1);
    }
    await prisma.$disconnect();
  } catch {
    // no database: fall back to the bank
  }
  if (counts.size < TOP) for (const r of loadBank()) if (getCommand(r.command)) counts.set(r.command, (counts.get(r.command) ?? 0) + 0.01);
  return [...counts.entries()].sort((a, b) => b[1] - a[1]).slice(0, TOP).map(([c]) => c);
}

const LANGS = {
  en: "English",
  ru: "Roman Urdu (Urdu written in English letters, the way students in Pakistan text, e.g. \"kal subah 9 baje gym jana hai\")",
};
const schema = z.object({ paraphrases: z.array(z.string().min(2).max(160)).min(1).max(40) });

const ai = getAi();
if (!ai.enabled || !ai.available) {
  console.error("The model is off or unavailable (see backend/.env); nothing written.");
  process.exit(1);
}
const commands = await mostUsed();
console.log(`Top ${commands.length} commands: ${commands.join(", ")}`);
const existing = existsSync(OUT) ? (JSON.parse(readFileSync(OUT, "utf8")) as Array<{ text: string }>) : [];
const seen = new Set([...existing.map((r) => r.text.toLowerCase()), ...loadBank().map((r) => r.text.toLowerCase())]);
const rows = [...existing] as Array<Record<string, unknown>>;
for (const name of commands) {
  const c = getCommand(name);
  if (!c) continue;
  for (const [lang, label] of Object.entries(LANGS)) {
    const out = await ai.json(
      [
        {
          role: "system",
          content: `You write test messages for a student planner app. Write ${PER} different messages a university student might send to ask for this, in ${label}. Vary the wording, length and tone; some short, some casual, a few with typos. Use made-up task names, times and days where needed. Each message must ask for exactly this and nothing else. Reply as JSON {"paraphrases": ["..."]}.`,
        },
        { role: "user", content: `What the app does: ${c.summary}.\nExamples: ${c.examples.map((e) => `"${e}"`).join(", ")}` },
      ],
      schema,
      { maxTokens: 1500, timeoutMs: 120000, temperature: 0.8 },
    );
    let n = 0;
    for (const text of out?.paraphrases ?? []) {
      const k = text.trim().toLowerCase();
      if (!k || seen.has(k)) continue;
      seen.add(k);
      rows.push({ text: text.trim(), lang, command: name, source: "paraphrase", model: process.env.OLLAMA_MODEL ?? "qwen2.5:7b", approved: false });
      n += 1;
    }
    console.log(`  ${name} [${lang}]: ${n} new`);
  }
}
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(OUT, `${JSON.stringify(rows, null, 1)}\n`);
console.log(`${rows.length} rows in ${OUT}, all approved: false until a person reviews them. Then npm run bank:approve.`);
process.exit(0);
