/**
 * TOTP (RFC 6238) — HMAC-SHA1, krok 30 s, 6 cyfr. Bez zależności zewnętrznych.
 * Sekret przechowywany jako base32 (bez paddingu), jak w aplikacjach authenticator.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

const BASE32_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(buf: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of buf) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32_ALPHABET.indexOf(char);
    if (idx === -1) throw new Error("Nieprawidłowy znak base32");
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

export function hotp(secret: Buffer, counter: number): string {
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", secret).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 10 ** DIGITS).padStart(DIGITS, "0");
}

export function totpAt(secretBase32: string, unixSeconds: number): string {
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  return hotp(base32Decode(secretBase32), counter);
}

/**
 * Weryfikacja z tolerancją ±1 kroku (30 s) na rozjazd zegara.
 * Porównanie w czasie stałym.
 */
export function verifyTotp(secretBase32: string, code: string, unixSeconds = Date.now() / 1000): boolean {
  const normalized = code.replace(/\s+/g, "");
  if (!/^\d{6}$/.test(normalized)) return false;
  const counter = Math.floor(unixSeconds / STEP_SECONDS);
  const provided = Buffer.from(normalized);
  for (const drift of [-1, 0, 1]) {
    const expected = Buffer.from(hotp(base32Decode(secretBase32), counter + drift));
    if (expected.length === provided.length && timingSafeEqual(expected, provided)) return true;
  }
  return false;
}

export function otpauthUri(secretBase32: string, accountName: string, issuer = "Userbase"): string {
  const label = encodeURIComponent(`${issuer}:${accountName}`);
  const params = new URLSearchParams({
    secret: secretBase32,
    issuer,
    algorithm: "SHA1",
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** Kody odzyskiwania: 10 jednorazowych kodów w formacie xxxx-xxxx. */
export function generateRecoveryCodes(count = 10): string[] {
  const codes: string[] = [];
  const alphabet = "abcdefghijkmnpqrstuvwxyz23456789";
  for (let i = 0; i < count; i += 1) {
    let code = "";
    for (let j = 0; j < 8; j += 1) {
      const byte = randomBytes(1)[0] % alphabet.length;
      code += alphabet[byte];
    }
    codes.push(`${code.slice(0, 4)}-${code.slice(4)}`);
  }
  return codes;
}
