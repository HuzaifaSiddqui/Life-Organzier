import crypto from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * WhatsApp Agent API keys (and chat references) at rest: AES-256-GCM with WHATSAPP_KEY_SECRET (32 bytes, as 64 hex
 * characters or base64). Without it the server makes its own on first start and keeps it in
 * backend/.secrets/whatsapp-key-secret (git-ignored, or WHATSAPP_KEY_SECRET_FILE): nothing to set up. Losing that file
 * means every user pastes their key again, so back it up (or set WHATSAPP_KEY_SECRET) on a real server.
 * The owner's user id is the additional authenticated data, so a ciphertext copied to another user's row does not decrypt. Format: v1:<iv>:<tag>:<ciphertext> (base64). Errors never include the value.
 */

export class SecretConfigError extends Error {
  constructor() {
    super("WHATSAPP_KEY_SECRET must be 32 bytes: 64 hex characters or base64");
  }
}

function decode(raw: string): Buffer {
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new SecretConfigError();
  return key;
}

export function secretFile(): string {
  return process.env.WHATSAPP_KEY_SECRET_FILE || fileURLToPath(new URL("../../../.secrets/whatsapp-key-secret", import.meta.url));
}

let generated: Buffer | null = null;

/** WHATSAPP_KEY_SECRET if set (an invalid one is an error, never silently replaced); else the saved or a new one. */
function secretKey(): Buffer {
  const raw = (process.env.WHATSAPP_KEY_SECRET ?? "").trim();
  if (raw) return decode(raw);
  if (generated) return generated;
  const file = secretFile();
  if (existsSync(file)) {
    generated = decode(readFileSync(file, "utf8").trim());
    return generated;
  }
  const fresh = crypto.randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  try {
    writeFileSync(file, fresh.toString("hex"), { flag: "wx" }); // never overwrites a secret another process just wrote
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    generated = decode(readFileSync(file, "utf8").trim());
    return generated;
  }
  try {
    chmodSync(file, 0o600);
  } catch {
    // Windows: permissions come from the folder
  }
  console.info(`WhatsApp Agent: created a key-encryption secret in ${file}. Back it up; without it users must reconnect.`);
  generated = fresh;
  return generated;
}

/** Test hook: forget the cached generated secret. */
export function resetGeneratedSecret(): void {
  generated = null;
}

export function secretConfigured(): boolean {
  try {
    secretKey();
    return true;
  } catch {
    return false;
  }
}

export function encryptSecret(plain: string, ownerId: string): string {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", secretKey(), iv);
  cipher.setAAD(Buffer.from(`whatsapp-agent:${ownerId}`));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return ["v1", iv.toString("base64"), cipher.getAuthTag().toString("base64"), body.toString("base64")].join(":");
}

export function decryptSecret(blob: string, ownerId: string): string {
  const [v, iv, tag, body] = blob.split(":");
  if (v !== "v1" || !iv || !tag || !body) throw new Error("Unreadable secret");
  try {
    const decipher = crypto.createDecipheriv("aes-256-gcm", secretKey(), Buffer.from(iv, "base64"));
    decipher.setAAD(Buffer.from(`whatsapp-agent:${ownerId}`));
    decipher.setAuthTag(Buffer.from(tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(body, "base64")), decipher.final()]).toString("utf8");
  } catch (error) {
    if (error instanceof SecretConfigError) throw error;
    throw new Error("Unreadable secret"); // wrong secret or tampered row; the message never carries the value
  }
}

export function last4(key: string): string {
  return key.trim().slice(-4);
}
