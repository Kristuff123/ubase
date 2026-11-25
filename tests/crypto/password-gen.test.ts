import { describe, expect, it } from "vitest";
import { __setRandomInt, generatePassword, isCompliantPassword } from "@/lib/crypto/password-gen";

describe("generator haseł", () => {
  it("domyślnie generuje 8 znaków", () => {
    const { password } = generatePassword();
    expect(password).toHaveLength(8);
  });

  it("używa wyłącznie małych liter i cyfr", () => {
    for (let i = 0; i < 200; i += 1) {
      expect(generatePassword().password).toMatch(/^[a-z0-9]+$/);
    }
  });

  it("ma co najwyżej 3 cyfry", () => {
    for (let i = 0; i < 500; i += 1) {
      const { password, digits } = generatePassword();
      expect(digits).toBeLessThanOrEqual(3);
      expect(password).toBe(password.toLowerCase());
    }
  });

  it("zawsze zawiera literę", () => {
    for (let i = 0; i < 500; i += 1) {
      expect(generatePassword().password).toMatch(/[a-z]/);
    }
  });

  it("respektuje maksymalną liczbę cyfr = 0", () => {
    for (let i = 0; i < 100; i += 1) {
      const { password } = generatePassword({ maxDigits: 0, minDigits: 0 });
      expect(password).toMatch(/^[a-z]+$/);
    }
  });

  it("respektuje długość 24 i limit 2 cyfr", () => {
    for (let i = 0; i < 100; i += 1) {
      const { password, digits } = generatePassword({ length: 24, maxDigits: 2 });
      expect(password).toHaveLength(24);
      expect(digits).toBeLessThanOrEqual(2);
    }
  });

  it("wariant mocny zawiera wielkie litery, cyfrę i symbol", () => {
    for (let i = 0; i < 50; i += 1) {
      const { password } = generatePassword({ length: 12, strong: true });
      expect(password).toHaveLength(12);
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
    }
  });

  it("wariant mocny gwarantuje małą literę nawet gdy losowanie wybiera wielkie", () => {
    __setRandomInt((_min, max) => max);
    try {
      const { password } = generatePassword({ length: 12, strong: true });
      expect(password).toMatch(/[A-Z]/);
      expect(password).toMatch(/[a-z]/);
      expect(password).toMatch(/[0-9]/);
      expect(password).toMatch(/[^A-Za-z0-9]/);
    } finally {
      __setRandomInt(null);
    }
  });

  it("nie powtarza haseł w serii 1000 losowań", () => {
    const set = new Set<string>();
    for (let i = 0; i < 1000; i += 1) set.add(generatePassword().password);
    expect(set.size).toBe(1000);
  });

  it("rozrzut cyfr jest zróżnicowany (brak stałej liczby cyfr)", () => {
    const counts = new Map<number, number>();
    for (let i = 0; i < 400; i += 1) {
      const { digits } = generatePassword({ maxDigits: 3 });
      counts.set(digits, (counts.get(digits) ?? 0) + 1);
    }
    expect(counts.size).toBeGreaterThan(1);
  });

  it("odrzuca nieprawidłową długość", () => {
    expect(() => generatePassword({ length: 3 })).toThrow();
    expect(() => generatePassword({ length: 100 })).toThrow();
  });

  it("odrzuca limit cyfr większy niż długość", () => {
    expect(() => generatePassword({ length: 8, maxDigits: 8 })).toThrow();
  });

  it("isCompliantPassword akceptuje wynik generatora", () => {
    for (let i = 0; i < 100; i += 1) {
      expect(isCompliantPassword(generatePassword().password)).toBe(true);
    }
  });

  it("isCompliantPassword odrzuca hasło z 4 cyframi", () => {
    expect(isCompliantPassword("abcd1234")).toBe(false);
  });
});
