import { randomInt } from "node:crypto";

/** Normalise any user-entered code: trim, uppercase, strip spaces/dashes. */
export function normaliseCode(raw: string): string | null {
  const c = raw.trim().toUpperCase().replace(/[\s-]+/g, "");
  return /^[A-Z0-9]{6,40}$/.test(c) ? c : null;
}

// No 0/O/1/I/L to avoid read-out errors over WhatsApp/phone.
const ALPHABET = "23456789ABCDEFGHJKMNPQRSTUVWXYZ";
export function generateOrderCode(len = 6): string {
  let s = "";
  for (let i = 0; i < len; i++) s += ALPHABET[randomInt(ALPHABET.length)];
  return `CR${s}`;
}
export const generateHandoverCode = (): string => String(randomInt(0, 1_000_000)).padStart(6, "0");
