/**
 * Szyfrowanie kopertowe (envelope encryption).
 *
 * KEK (key encryption key) — poza bazą: zmienna USERBASE_KEK (base64, 32 B) albo plik
 * wskazany przez USERBASE_KEK_FILE. DEK (data encryption key) — losowy, trzymany w tabeli
 * crypto_keys w formie zaszyfrowanej KEK-iem. Wszystkie sekrety w aplikacji szyfrowane DEK-iem.
 *
 * Format szyfrogramu: v1.<iv_b64>.<tag_b64>.<ct_b64>
 * AAD wiąże wartość z rekordem — podmiana szyfrogramu między rekordami kończy się błędem.
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;

export class CryptoConfigError extends Error {}

export function parseKey(raw: string, source: string): Buffer {
  let buf: Buffer;
  try {
    buf = Buffer.from(raw.trim(), "base64");
  } catch {
    throw new CryptoConfigError(`Nieprawidłowy klucz (${source}): oczekiwano base64`);
  }
  if (buf.length !== KEY_LEN) {
    throw new CryptoConfigError(
      `Nieprawidłowy klucz (${source}): oczekiwano ${KEY_LEN} bajtów, jest ${buf.length}`,
    );
  }
  return buf;
}

/** Klucz główny z konfiguracji. Rzuca, jeśli brak — aplikacja nie startuje (fail closed). */
export function loadKek(env: NodeJS.ProcessEnv = process.env): Buffer {
  const fromEnv = env.USERBASE_KEK;
  if (fromEnv && fromEnv.trim()) return parseKey(fromEnv, "USERBASE_KEK");
  const fromFile = env.USERBASE_KEK_FILE;
  if (fromFile && fromFile.trim()) {
    let content: string;
    try {
      content = readFileSync(fromFile.trim(), "utf8");
    } catch {
      throw new CryptoConfigError(`Nie można odczytać pliku klucza: ${fromFile}`);
    }
    return parseKey(content, "USERBASE_KEK_FILE");
  }
  throw new CryptoConfigError(
    "Brak klucza głównego: ustaw USERBASE_KEK lub USERBASE_KEK_FILE. Aplikacja nie uruchomi się bez szyfrowania.",
  );
}

export function generateKey(): Buffer {
  return randomBytes(KEY_LEN);
}

export function encryptWithKey(plain: string, key: Buffer, aad: string): string {
  const iv = randomBytes(IV_LEN);
  const cipher = createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1.${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptWithKey(payload: string, key: Buffer, aad: string): string {
  const parts = payload.split(".");
  if (parts.length !== 4 || parts[0] !== "v1") {
    throw new CryptoConfigError("Nieprawidłowy format szyfrogramu");
  }
  const [, ivB64, tagB64, ctB64] = parts;
  const decipher = createDecipheriv(ALGO, key, Buffer.from(ivB64, "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(tagB64, "base64"));
  return Buffer.concat([
    decipher.update(Buffer.from(ctB64, "base64")),
    decipher.final(),
  ]).toString("utf8");
}

/** AAD dla sekretu dostępu — wiąże wartość z konkretnym rekordem i polem. */
export function accessFieldAad(workerId: number, accessId: number, fieldKey: string): string {
  return `access:${workerId}:${accessId}:${fieldKey}`;
}

/** AAD dla sekretu TOTP konta aplikacji. */
export function totpAad(userId: number): string {
  return `app_user:${userId}:totp`;
}
