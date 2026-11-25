import { describe, expect, it } from "vitest";
import { base32Decode, base32Encode, generateTotpSecret, hotp, totpAt, verifyTotp } from "@/lib/crypto/totp";

describe("TOTP / base32", () => {
  it("koduje i dekoduje base32 bez straty danych", () => {
    for (const len of [1, 10, 20, 32]) {
      const buf = Buffer.alloc(len, len);
      expect(base32Decode(base32Encode(buf)).equals(buf)).toBe(true);
    }
  });

  it("RFC 6238 — wektor testowy SHA1 (counter=1, sekret 20x ti)", () => {
    // Sekret "12345678901234567890" w ASCII → base32.
    const secret = base32Encode(Buffer.from("12345678901234567890", "ascii"));
    expect(hotp(base32Decode(secret), 1)).toBe("287082");
    expect(hotp(base32Decode(secret), 0)).toBe("755224");
  });

  it("totpAt zwraca 6 cyfr", () => {
    const secret = generateTotpSecret();
    expect(totpAt(secret, 1_700_000_000)).toMatch(/^\d{6}$/);
  });

  it("weryfikuje bieżący kod", () => {
    const secret = generateTotpSecret();
    const nowSec = 1_700_000_000;
    expect(verifyTotp(secret, totpAt(secret, nowSec), nowSec)).toBe(true);
  });

  it("toleruje ±1 krok (rozjazd zegara)", () => {
    const secret = generateTotpSecret();
    const nowSec = 1_700_000_000;
    expect(verifyTotp(secret, totpAt(secret, nowSec - 30), nowSec)).toBe(true);
    expect(verifyTotp(secret, totpAt(secret, nowSec + 30), nowSec)).toBe(true);
  });

  it("odrzuca kod z odległego kroku", () => {
    const secret = generateTotpSecret();
    const nowSec = 1_700_000_000;
    expect(verifyTotp(secret, totpAt(secret, nowSec - 300), nowSec)).toBe(false);
  });

  it("odrzuca kod nieprawidłowego formatu", () => {
    const secret = generateTotpSecret();
    expect(verifyTotp(secret, "12345")).toBe(false);
    expect(verifyTotp(secret, "abcdef")).toBe(false);
    expect(verifyTotp(secret, "")).toBe(false);
  });

  it("generuje różne sekrety", () => {
    expect(generateTotpSecret()).not.toBe(generateTotpSecret());
  });
});
