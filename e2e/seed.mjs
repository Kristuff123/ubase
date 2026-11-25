#!/usr/bin/env node
/**
 * Deterministyczna baza do testów E2E.
 *
 * Tworzy od zera: schemat, klucz danych, konta o znanych hasłach, jednostki
 * organizacyjne, jednego pracownika z dostępem Axel (z sekretem do podejrzenia)
 * oraz jednego pracownika w archiwum.
 *
 * Moduł eksportuje `seedDatabase(file)`; uruchomiony bezpośrednio zasiewa bazę
 * wskazaną przez USERBASE_DB_PATH.
 */
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const requireCjs = createRequire(import.meta.url);
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const lib = requireCjs(path.join(root, "scripts", "lib.cjs"));

export const ACCOUNTS = {
  admin: { username: "admin", password: "Admin-Haslo-2026!", role: "admin", displayName: "Anna Admin" },
  operator: { username: "operator", password: "Operator-Haslo-2026!", role: "operator", displayName: "Olaf Operator" },
  audytor: { username: "audytor", password: "Audytor-Haslo-2026!", role: "audytor", displayName: "Ada Audytor" },
  // Konto z 2FA — sekret znany testom, żeby mogły policzyć kod TOTP.
  dwaFa: { username: "dwaefa", password: "DwaFa-Haslo-2026!", role: "operator", displayName: "Darek DwaFa" },
  // Konto wyłącznie do testu blokady po 5 błędnych próbach. Bez wydzielonego
  // konta ten test trwale blokuje `operator` na 15 minut i wysypuje wszystkie
  // późniejsze pliki specy (limit jest per konto i nie da się go wyczyścić z UI).
  blokada: { username: "blokada", password: "Blokada-Haslo-2026!", role: "audytor", displayName: "Bogdan Blokada" },
};

/** Sekret TOTP w base32 (20 bajtów zapisanych na stałe — wyłącznie do testów). */
export const TOTP_SECRET = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";

/** Hasło dostępu Axel — testy podejrzenia muszą znać wartość. */
export const SECRET_PASSWORD = "tajne-haslo-axel-123";

export const ORG_UNITS = [
  { type: "region", name: "Mazowiecki", number: null },
  { type: "region", name: "Pomorski", number: null },
  { type: "region", name: "Zachodniopomorski", number: null },
  { type: "zaklad", name: "PIEKARNIA", number: null },
  { type: "zaklad", name: "BISTRO", number: null },
  { type: "zaklad", name: "CUKIERNIA", number: null },
  { type: "zaklad", name: "DESERÓWKA", number: null },
  { type: "zaklad", name: "ADMINISTRACJA", number: null },
  { type: "zaklad", name: "PIEROGARNIA", number: null },
  { type: "sklep", name: "Sklep Centrum", number: "101" },
  { type: "sklep", name: "Sklep Gdańsk Główna", number: "204" },
  { type: "biuro", name: "Biuro Warszawa", number: null },
];

/** Lustro `foldDiacritics` z src/lib/utils.ts — do wypełnienia search_blob w seedzie. */
function fold(input) {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

/**
 * Zasiewa bazę w podanej ścieżce. Zwraca identyfikatory utworzonych rekordów.
 * Wymaga USERBASE_KEK w środowisku (klucz główny do opakowania DEK).
 */
export async function seedDatabase(file) {
  for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(`${file}${suffix}`, { force: true });
  fs.mkdirSync(path.dirname(file), { recursive: true });

  const db = lib.openDb(file);
  lib.runMigrations(db);
  lib.ensureInitialKey(db);

  const ts = Date.UTC(2026, 0, 15, 9, 0, 0);

  const userIds = {};
  for (const [key, account] of Object.entries(ACCOUNTS)) {
    const hash = await lib.hashPassword(account.password);
    const id = db
      .prepare(
        `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
         VALUES (?, ?, ?, ?, 0, ?)`,
      )
      .run(account.username, account.displayName, account.role, hash, ts).lastInsertRowid;
    userIds[key] = Number(id);
  }

  // Konto z 2FA: sekret zaszyfrowany kluczem danych, wersja klucza w app_user_secrets.
  const { dek, version } = lib.getActiveKey(db);
  db.prepare("UPDATE app_users SET totp_secret_enc = ?, totp_enabled = 1 WHERE id = ?").run(
    lib.encryptWithKey(TOTP_SECRET, dek, `app_user:${userIds.dwaFa}:totp`),
    userIds.dwaFa,
  );
  db.prepare("INSERT INTO app_user_secrets (user_id, kind, key_version) VALUES (?, 'totp', ?)").run(
    userIds.dwaFa,
    version,
  );

  const unitIds = {};
  const insertUnit = db.prepare("INSERT INTO org_units (type, name, number, created_at) VALUES (?, ?, ?, ?)");
  for (const unit of ORG_UNITS) {
    unitIds[unit.name] = Number(insertUnit.run(unit.type, unit.name, unit.number, ts).lastInsertRowid);
  }

  // Pracownik z dostępem Axel — cel testu podejrzenia sekretu.
  const workerId = Number(
    db
      .prepare(
        `INSERT INTO workers (first_name, last_name, position, org_unit_id, email, phone, notes, status, search_blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'aktywny', ?, ?, ?)`,
      )
      .run(
        "Zofia",
        "Żółkiewska",
        "kierownik zmiany",
        unitIds.PIEKARNIA,
        "zofia.zolkiewska@firma.pl",
        "600 100 200",
        "Osoba testowa z seeda.",
        fold("Zofia Żółkiewska kierownik zmiany PIEKARNIA zofia.zolkiewska@firma.pl"),
        ts,
        ts,
      ).lastInsertRowid,
  );

  const axelCategory = db.prepare("SELECT id FROM access_categories WHERE slug = 'axel'").get();
  const accessId = Number(
    db
      .prepare(
        `INSERT INTO accesses (worker_id, category_id, title, status, resource_owner, created_at, updated_at, created_by)
         VALUES (?, ?, ?, 'aktywny', 'firma', ?, ?, ?)`,
      )
      .run(workerId, axelCategory.id, "Axel — piekarnia", ts, ts, userIds.admin).lastInsertRowid,
  );

  const insertField = db.prepare(
    "INSERT INTO access_fields (access_id, field_key, value_text, value_enc, key_version) VALUES (?, ?, ?, ?, ?)",
  );
  insertField.run(accessId, "login", "zofia.piekarnia", null, null);
  insertField.run(
    accessId,
    "password",
    null,
    lib.encryptWithKey(SECRET_PASSWORD, dek, `access:${workerId}:${accessId}:password`),
    version,
  );

  // Pracownik w archiwum — żeby filtr „Archiwum” miał co pokazać.
  const archivedWorkerId = Number(
    db
      .prepare(
        `INSERT INTO workers (first_name, last_name, position, org_unit_id, status, search_blob, created_at, updated_at, archived_at, archived_by)
         VALUES (?, ?, ?, ?, 'zarchiwizowany', ?, ?, ?, ?, ?)`,
      )
      .run(
        "Marek",
        "Archiwalny",
        "dawny pracownik",
        unitIds.BISTRO,
        fold("Marek Archiwalny dawny pracownik BISTRO"),
        ts,
        ts,
        ts + 86_400_000,
        userIds.admin,
      ).lastInsertRowid,
  );

  lib.appendAudit(db, {
    action: "system.seed",
    actor: { userId: null, name: "e2e" },
    summary: "Baza testowa E2E przygotowana",
    details: { workers: 2, accounts: Object.keys(ACCOUNTS).length, units: ORG_UNITS.length },
  });

  db.close();
  return { userIds, unitIds, workerId, accessId, archivedWorkerId };
}

const isDirectRun = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isDirectRun) {
  const target = process.env.USERBASE_DB_PATH || path.join(root, "e2e", ".tmp", "userbase.db");
  seedDatabase(target)
    .then((result) => {
      console.log(`[seed] ${target}`);
      console.log(`[seed] konta: ${Object.keys(ACCOUNTS).join(", ")}`);
      console.log(`[seed] pracownik #${result.workerId}, dostęp #${result.accessId}, sekret: ${SECRET_PASSWORD}`);
    })
    .catch((error) => {
      console.error(`[seed] BŁĄD: ${error.stack || error.message}`);
      process.exit(1);
    });
}
