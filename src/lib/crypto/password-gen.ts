/**
 * Generator haseł: domyślnie 8 znaków, małe litery a–z, maksymalnie 3 cyfry.
 * Losowanie wyłącznie z CSPRNG (crypto.randomInt) — bez Math.random.
 */

export const LOWER = "abcdefghijklmnopqrstuvwxyz";
export const DIGITS = "0123456789";
export const UPPER = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";
export const SYMBOLS = "!@#$%^&*()-_=+[]{}";

export type PasswordOptions = {
  length?: number;
  maxDigits?: number;
  minDigits?: number;
  strong?: boolean;
};

export type PasswordResult = {
  password: string;
  digits: number;
  length: number;
};

export const DEFAULT_OPTIONS = {
  length: 8,
  maxDigits: 3,
  minDigits: 1,
  strong: false,
} as const;

function randInt(maxExclusive: number): number {
  if (maxExclusive <= 0) throw new Error("Zakres losowania musi być dodatni");
  return randomIntInclusive(0, maxExclusive - 1);
}

// Wydzielone, żeby testy mogły podmienić źródło losowości.
let randomIntInclusive: (min: number, max: number) => number = (min, max) => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { randomInt } = require("node:crypto") as typeof import("node:crypto");
  return randomInt(min, max + 1);
};

/** Testy: podstawienie deterministycznego RNG. */
export function __setRandomInt(fn: ((min: number, max: number) => number) | null): void {
  randomIntInclusive =
    fn ??
    ((min, max) => {
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const { randomInt } = require("node:crypto") as typeof import("node:crypto");
      return randomInt(min, max + 1);
    });
}

function pick(pool: string): string {
  return pool[randInt(pool.length)];
}

/**
 * Generuje hasło spełniające reguły:
 * - długość z zakresu 4–64 (domyślnie 8),
 * - wyłącznie małe litery i cyfry (chyba że `strong`),
 * - liczba cyfr między minDigits a maxDigits (domyślnie 1..3),
 * - co najmniej jedna litera.
 */
export function generatePassword(options: PasswordOptions = {}): PasswordResult {
  const length = options.length ?? DEFAULT_OPTIONS.length;
  const maxDigits = options.maxDigits ?? DEFAULT_OPTIONS.maxDigits;
  const minDigits = options.minDigits ?? DEFAULT_OPTIONS.minDigits;
  const strong = options.strong ?? DEFAULT_OPTIONS.strong;

  if (!Number.isInteger(length) || length < 4 || length > 64) {
    throw new Error("Długość hasła musi być liczbą całkowitą z zakresu 4–64");
  }
  if (!Number.isInteger(maxDigits) || maxDigits < 0 || maxDigits > length - 1) {
    throw new Error("Maksymalna liczba cyfr musi mieścić się w długości hasła i pozostawić miejsce na literę");
  }
  if (!Number.isInteger(minDigits) || minDigits < 0 || minDigits > maxDigits) {
    throw new Error("Minimalna liczba cyfr musi być nie większa niż maksymalna");
  }
  if (strong && length < 8) {
    throw new Error("Wariant mocny wymaga co najmniej 8 znaków");
  }
  const effectiveMinDigits = strong ? Math.max(minDigits, 1) : minDigits;
  if (strong && effectiveMinDigits > length - 3) {
    throw new Error("Wariant mocny wymaga miejsca na cyfrę, małą literę, wielką literę i symbol");
  }

  // Mocny wariant rezerwuje trzy miejsca na wymagane klasy znaków.
  const maxDigitCount = strong ? Math.min(maxDigits, length - 3) : maxDigits;
  if (effectiveMinDigits > maxDigitCount) {
    throw new Error("Minimalna liczba cyfr jest zbyt duża dla wariantu mocnego");
  }
  const digitCount = effectiveMinDigits + randInt(maxDigitCount - effectiveMinDigits + 1);

  const chars: string[] = [];
  for (let i = 0; i < digitCount; i += 1) chars.push(pick(DIGITS));

  const letterPool = strong ? LOWER + UPPER : LOWER;
  for (let i = digitCount; i < length; i += 1) chars.push(pick(letterPool));

  if (strong) {
    // Trzy miejsca gwarantują symbol oraz małe i wielkie litery.
    const letterSlots = chars.map((c, i) => (i >= digitCount ? i : -1)).filter((i) => i >= 0);
    chars[letterSlots[0]] = pick(SYMBOLS);
    chars[letterSlots[1]] = pick(UPPER);
    chars[letterSlots[2]] = pick(LOWER);
  }

  // Tasowanie Fishera–Yatesa (bezstronne).
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = randInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }

  const password = chars.join("");
  const digits = (password.match(/[0-9]/g) ?? []).length;
  return { password, digits, length };
}

/** Czy hasło spełnia reguły domyślne (używane w walidacji i testach). */
export function isCompliantPassword(value: string, options: PasswordOptions = {}): boolean {
  const length = options.length ?? DEFAULT_OPTIONS.length;
  const maxDigits = options.maxDigits ?? DEFAULT_OPTIONS.maxDigits;
  const strong = options.strong ?? DEFAULT_OPTIONS.strong;
  if (value.length !== length) return false;
  if (strong) {
    if (!/^[A-Za-z0-9!@#$%^&*()\-_=+[\]{}]+$/.test(value)) return false;
    if (!/[A-Z]/.test(value) || !/[a-z]/.test(value)) return false;
  } else if (!/^[a-z0-9]+$/.test(value)) {
    return false;
  }
  const digits = (value.match(/[0-9]/g) ?? []).length;
  return digits <= maxDigits;
}
