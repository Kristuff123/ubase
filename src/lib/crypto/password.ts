/**
 * Hasła kont aplikacji — Argon2id (@node-rs/argon2, prebuilt).
 * Parametry: 64 MiB pamięci, 3 iteracje, równoległość 1 — bezpieczne dla serwera z 5 kontami.
 *
 * Uwaga: `Algorithm` w typach @node-rs/argon2 to `const enum`, którego nie da się
 * użyć przy `isolatedModules`. Wartość liczbowa 2 = Argon2id (0=d, 1=i, 2=id)
 * jest stabilną częścią API argon2 — pinujemy ją jako stałą.
 */
import { hash as argonHash, verify as argonVerify } from "@node-rs/argon2";

const ARGON2ID = 2;

export const ARGON_OPTIONS = {
  algorithm: ARGON2ID,
  memoryCost: 65536,
  timeCost: 3,
  parallelism: 1,
} as const;

export async function hashPassword(password: string): Promise<string> {
  if (password.length < 8) throw new Error("Hasło musi mieć co najmniej 8 znaków");
  return argonHash(password, ARGON_OPTIONS);
}

export async function verifyPassword(hash: string, password: string): Promise<boolean> {
  try {
    return await argonVerify(hash, password, ARGON_OPTIONS);
  } catch {
    return false;
  }
}
