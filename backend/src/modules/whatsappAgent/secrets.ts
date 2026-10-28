import crypto from "node:crypto";

/**
 * WhatsApp Agent API keys (and chat references) at rest: AES-256-GCM with WHATSAPP_KEY_SECRET (32 bytes, as 64 hex
 * characters or base64). The owner's user id is the additional authenticated data, so a ciphertext copied to
 * another user's row does not decrypt. Format: v1:<iv>:<tag>:<ciphertext> (base64). Errors never include the value.
 */

export class SecretConfigError extends Error {
  constructor() {
    super("WHATSAPP_KEY_SECRET must be 32 bytes: 64 hex characters or base64");
  }
}

function secretKey(): Buffer {
  const raw = (process.env.WHATSAPP_KEY_SECRET ?? "").trim();
  const key = /^[0-9a-f]{64}$/i.test(raw) ? Buffer.from(raw, "hex") : Buffer.from(raw, "base64");
  if (key.length !== 32) throw new SecretConfigError();
  return key;
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
