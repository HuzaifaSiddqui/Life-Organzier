import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const baseline = JSON.parse(readFileSync(join(root, "../docs/baselines/ollama-v1.json"), "utf8")) as {
  chatEval: { assistantEval: { correct: number; total: number }; knownMisses: string[] };
  pendingMatrix: { correct: number; total: number };
};

/**
 * With every new flag off (the default), chat is the saved baseline exactly (docs/baselines/ollama-v1.json): the
 * same score on the assistant eval, the same misses (no new wrong answers), the same pending matrix. Rules only, as
 * the baseline was recorded (AI off). Flags are cleared so a developer's .env can't hide a change.
 */
test("flags off: chat equals the ollama-v1 baseline (assistant eval, known misses, pending matrix)", () => {
  const env = { ...process.env };
  for (const k of Object.keys(env)) if (/^(CLOUD_FALLBACK|LLM_PROVIDERS_|LLM_TIER_B_|MEANING_ROUTER|BEDROCK_)/.test(k)) delete env[k];
  const run = spawnSync(process.execPath, ["--import", "tsx", "scripts/eval-assistant.ts"], { cwd: root, env, encoding: "utf8", timeout: 120000 });
  assert.equal(run.status, 0, run.stderr);
  const out = run.stdout;
  const score = out.match(/assistant-eval\.json: (\d+)\/(\d+)/);
  assert.deepEqual(score && [Number(score[1]), Number(score[2])], [baseline.chatEval.assistantEval.correct, baseline.chatEval.assistantEval.total]);
  const misses = [...out.matchAll(/^ {2}([a-z]+\d+) \[/gm)].map((m) => m[1]).sort();
  assert.deepEqual(misses, [...baseline.chatEval.knownMisses].sort(), "the same misses: nothing that worked before fails now");
  const pending = out.match(/pending \(open question \+ reply\): (\d+)\/(\d+)/);
  assert.deepEqual(pending && [Number(pending[1]), Number(pending[2])], [baseline.pendingMatrix.correct, baseline.pendingMatrix.total]);
});
