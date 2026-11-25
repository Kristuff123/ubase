/**
 * Połączenie z SQLite + migracje.
 *
 * better-sqlite3 jest synchroniczny — w transakcjach nie wolno używać `await`.
 * Baza w trybie WAL, z foreign_keys i busy_timeout.
 */
import Database from "better-sqlite3";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

export type Db = Database.Database;

const globalForDb = globalThis as unknown as { __userbaseDb?: Db };

export function dbPath(): string {
  return process.env.USERBASE_DB_PATH ?? path.join(process.cwd(), "data", "userbase.db");
}

function migrationsDir(): string {
  // W dev/build migracje leżą w `src/db/migrations`. W obrazie produkcyjnym
  // (output: standalone) kopiujemy je do `db/migrations` obok serwera.
  const candidates = [
    path.join(process.cwd(), "src", "db", "migrations"),
    path.join(process.cwd(), "db", "migrations"),
  ];
  for (const candidate of candidates) {
    try {
      if (readdirSync(candidate).length > 0) return candidate;
    } catch {
      // brak katalogu — próbujemy następny
    }
  }
  throw new Error(`Nie znaleziono katalogu migracji (szukano: ${candidates.join(", ")})`);
}

export function runMigrations(db: Db): number {
  const files = readdirSync(migrationsDir())
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const current = Number(db.pragma("user_version", { simple: true }) ?? 0);
  let applied = current;
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (!Number.isFinite(version) || version <= current) continue;
    const sql = readFileSync(path.join(migrationsDir(), file), "utf8");
    const tx = db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    });
    tx();
    applied = version;
  }
  return applied;
}

export function openDb(file = dbPath()): Db {
  const db = new Database(file);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  runMigrations(db);
  return db;
}

export function getDb(): Db {
  if (!globalForDb.__userbaseDb) {
    globalForDb.__userbaseDb = openDb();
  }
  return globalForDb.__userbaseDb;
}

/** Testy: świeże połączenie na podanej ścieżce (np. :memory:). */
export function createTestDb(): Db {
  return openDb(":memory:");
}

export function now(): number {
  return Date.now();
}
