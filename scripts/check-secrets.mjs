#!/usr/bin/env node
/**
 * Fails when a tracked (or, with --staged, a staged) file contains a key-like string, or when an .env.example
 * gives a secret variable a value. Prints file:line and the kind of match only, never the matched text.
 *
 *   node scripts/check-secrets.mjs            # every tracked file (CI)
 *   node scripts/check-secrets.mjs --staged   # staged content (pre-commit hook)
 *
 * Pre-commit hook, once per clone: git config core.hooksPath .githooks
 */
import { execFileSync } from "node:child_process";

export const PATTERNS = {
  groq: /gsk_[A-Za-z0-9]{20,}/,
  cerebras: /csk-[A-Za-z0-9]{20,}/,
  openrouter: /sk-or-v1-[A-Za-z0-9]{20,}/,
  openai: /\bsk-(?!or-)(?:proj-)?[A-Za-z0-9_-]{32,}/,
  google: /AIza[0-9A-Za-z_-]{30,}/,
  google_oauth: /\bAQ\.[A-Za-z0-9_-]{30,}/,
  aws: /\bAKIA[0-9A-Z]{16}\b/,
  github: /\bgh[pousr]_[A-Za-z0-9]{30,}/,
  private_key: /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
  bearer: /\bBearer [A-Za-z0-9._-]{30,}/,
};
// In an .env.example a secret-looking name must be empty, a placeholder in capitals, or a variable reference.
const SECRET_NAME = /^\s*#?\s*([A-Z0-9_]*(?:KEY|TOKEN|SECRET|PASSWORD)[A-Z0-9_]*)\s*=\s*(.*)$/;
const PLACEHOLDER = /^["']?(?:|[A-Z0-9_<>.:/@ -]*|\$\{?[A-Z0-9_]+\}?)["']?\s*(?:#.*)?$/;

/** Problems in one file's text: [{ line, kind }]. */
export function scan(path, text) {
  const out = [];
  const example = /(^|\/)\.env\.example$/.test(path);
  text.split("\n").forEach((line, i) => {
    for (const [kind, re] of Object.entries(PATTERNS)) if (re.test(line)) out.push({ line: i + 1, kind });
    const m = example && SECRET_NAME.exec(line);
    if (m && !PLACEHOLDER.test(m[2].trim())) out.push({ line: i + 1, kind: `value for ${m[1]} in .env.example` });
  });
  return out;
}

function main() {
  const staged = process.argv.includes("--staged");
  const git = (...args) => execFileSync("git", args, { maxBuffer: 1e9 }).toString();
  const files = (staged ? git("diff", "--cached", "--name-only", "--diff-filter=ACMR") : git("ls-files")).split("\n").filter(Boolean);
  let problems = 0;
  for (const f of files) {
    let buf;
    try {
      buf = staged ? execFileSync("git", ["show", `:${f}`], { maxBuffer: 1e9, stdio: ["ignore", "pipe", "ignore"] }) : execFileSync("git", ["show", `HEAD:${f}`], { maxBuffer: 1e9, stdio: ["ignore", "pipe", "ignore"] });
    } catch {
      continue; // deleted or not in HEAD yet
    }
    if (buf.includes(0)) continue; // binary
    for (const p of scan(f, buf.toString())) {
      console.log(`${f}:${p.line}: ${p.kind}`);
      problems += 1;
    }
  }
  if (problems) {
    console.log(`\n${problems} key-like string(s) found. Remove them (keys belong in backend/.env, which is git-ignored) and rotate any key that was pushed.`);
    process.exit(1);
  }
  console.log(`check-secrets: ${files.length} file(s) clean`);
}

if (import.meta.url === `file://${process.argv[1]}`) main();
