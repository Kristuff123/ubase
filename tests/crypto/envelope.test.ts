import { describe, expect, it } from "vitest";
import {
  accessFieldAad,
  CryptoConfigError,
  decryptWithKey,
  encryptWithKey,
  generateKey,
  loadKek,
} from "@/lib/crypto/envelope";

describe("szyfrowanie kopertowe", () => {
  const key = Buffer.alloc(32, 3);
  const aad = accessFieldAad(1, 2, "password");

  it("odszyfrowuje z powrotem do oryginału", () => {
    const payload = encryptWithKey("TajneHasło123!", key, aad);
    expect(decryptWithKey(payload, key, aad)).toBe("TajneHasło123!");
  });

  it("nie ujawnia wartości w szyfrogramie", () => {
    const payload = encryptWithKey("haslo-do-axela", key, aad);
    expect(payload).not.toContain("haslo");
    expect(payload.startsWith("v1.")).toBe(true);
  });

  it("każdy zapis ma inny nonce (brak powtarzalności)", () => {
    const a = encryptWithKey("to samo", key, aad);
    const b = encryptWithKey("to samo", key, aad);
    expect(a).not.toBe(b);
  });

  it("odrzuca wartość podmienioną między rekordami (AAD)", () => {
    const payload = encryptWithKey("sekret", key, accessFieldAad(1, 10, "password"));
    expect(() => decryptWithKey(payload, key, accessFieldAad(1, 11, "password"))).toThrow();
  });

  it("odrzuca zły klucz", () => {
    const payload = encryptWithKey("sekret", key, aad);
    expect(() => decryptWithKey(payload, generateKey(), aad)).toThrow();
  });

  it("wykrywa manipulację szyfrogramem", () => {
    const payload = encryptWithKey("sekret", key, aad);
    const parts = payload.split(".");
    const mutatedCt = Buffer.from(parts[3], "base64");
    mutatedCt[0] ^= 0xff;
    const tampered = [parts[0], parts[1], parts[2], mutatedCt.toString("base64")].join(".");
    expect(() => decryptWithKey(tampered, key, aad)).toThrow();
  });

  it("odrzuca nieprawidłowy format", () => {
    expect(() => decryptWithKey("v2.a.b.c", key, aad)).toThrow(CryptoConfigError);
    expect(() => decryptWithKey("bzdura", key, aad)).toThrow(CryptoConfigError);
  });

  it("loadKek wymaga klucza (fail closed)", () => {
    expect(() => loadKek({} as unknown as NodeJS.ProcessEnv)).toThrow(CryptoConfigError);
  });

  it("loadKek odrzuca klucz o złej długości", () => {
    expect(() =>
      loadKek({ USERBASE_KEK: Buffer.alloc(16, 1).toString("base64") } as unknown as NodeJS.ProcessEnv),
    ).toThrow(CryptoConfigError);
  });

  it("loadKek przyjmuje poprawny klucz", () => {
    const kek = loadKek({ USERBASE_KEK: Buffer.alloc(32, 9).toString("base64") } as unknown as NodeJS.ProcessEnv);
    expect(kek.length).toBe(32);
  });
});
