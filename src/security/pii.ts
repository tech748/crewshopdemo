import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes } from "node:crypto";
import { env } from "../config.js";

if (env.NODE_ENV === "production" && !env.PII_ENCRYPTION_KEY) throw new Error("PII_ENCRYPTION_KEY required in production");
const secret = env.PII_ENCRYPTION_KEY ?? "dev-only-key-do-not-use-in-production!!";
const key = createHash("sha256").update(secret).digest();

/** AES-256-GCM, output = base64(iv|tag|ciphertext). */
export function encryptPii(plain: string): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", key, iv);
  const enc = Buffer.concat([c.update(plain, "utf8"), c.final()]);
  return Buffer.concat([iv, c.getAuthTag(), enc]).toString("base64");
}
export function decryptPii(b64: string): string {
  const b = Buffer.from(b64, "base64");
  const d = createDecipheriv("aes-256-gcm", key, b.subarray(0, 12));
  d.setAuthTag(b.subarray(12, 28));
  return Buffer.concat([d.update(b.subarray(28)), d.final()]).toString("utf8");
}
/** Deterministic keyed hash for lookups (phone numbers). */
export const hashPii = (v: string): string => createHmac("sha256", key).update(v).digest("hex");
