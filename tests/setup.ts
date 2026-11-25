/**
 * Wspólne przygotowanie testów: deterministyczny klucz główny i świeża baza w pamięci.
 */
import { randomBytes } from "node:crypto";
import { beforeAll } from "vitest";

// Klucz testowy — nie może być używany produkcyjnie (produkcja wymaga sekretu z zewnątrz).
process.env.USERBASE_KEK = Buffer.alloc(32, 7).toString("base64");
delete process.env.USERBASE_KEK_FILE;

beforeAll(() => {
  if (!process.env.USERBASE_KEK) {
    process.env.USERBASE_KEK = randomBytes(32).toString("base64");
  }
});
