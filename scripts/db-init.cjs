#!/usr/bin/env node
/**
 * Inicjalizacja bazy: migracje, klucz danych, konto startowe admina.
 *
 * Uruchamiaj przy pierwszym wdrożeniu albo po odtworzeniu z kopii:
 *   USERBASE_KEK=... node scripts/db-init.cjs
 *
 * Hasło startowe jest losowane i wypisywane RAZ. Konto wymusza zmianę przy logowaniu.
 */
"use strict";

const lib = require("./lib.cjs");

async function main() {
  console.log("\nuserbase — inicjalizacja bazy\n");

  let kek;
  try {
    kek = lib.loadKek();
  } catch (error) {
    lib.fail(error.message);
  }
  lib.ok(`Klucz główny wczytany (${kek.length} B)`);

  const db = lib.openDb();
  const version = lib.runMigrations(db);
  lib.ok(`Baza gotowa: ${lib.dbPath()} (schemat v${version})`);

  const keyVersion = lib.ensureInitialKey(db);
  lib.ok(`Klucz danych (DEK) v${keyVersion}`);

  const count = db.prepare("SELECT COUNT(*) AS c FROM app_users").get().c;
  if (count > 0) {
    lib.info(`Kont w bazie: ${count} — pomijam tworzenie admina`);
  } else {
    const password = lib.generatePassword({ length: 20, maxDigits: 4 });
    const hash = await lib.hashPassword(password);
    db.prepare(
      `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
       VALUES ('admin', 'Administrator', 'admin', ?, 1, ?)`,
    ).run(hash, Date.now());
    lib.appendAudit(db, {
      action: "user.created",
      actor: { userId: null, name: "system" },
      summary: "Utworzono konto startowe admin (wymuszona zmiana hasła)",
      entityType: "app_user",
      entityId: 1,
    });

    console.log("\n┌────────────────────────────────────────────────────────────┐");
    console.log("│  KONTO STARTOWE — zapisz teraz, nie będzie pokazane ponownie │");
    console.log("├────────────────────────────────────────────────────────────┤");
    console.log(`│  login:  admin                                              │`);
    console.log(`│  hasło:  ${password.padEnd(50)}│`);
    console.log("└────────────────────────────────────────────────────────────┘\n");
    lib.info("Przy pierwszym logowaniu aplikacja wymusi zmianę hasła.");
  }

  const keys = db.prepare("SELECT COUNT(*) AS c FROM crypto_keys").get().c;
  const workers = db.prepare("SELECT COUNT(*) AS c FROM workers").get().c;
  const accesses = db.prepare("SELECT COUNT(*) AS c FROM accesses").get().c;
  const events = db.prepare("SELECT COUNT(*) AS c FROM audit_events").get().c;
  console.log(`\nStan: ${workers} pracowników, ${accesses} dostępów, ${events} zdarzeń audytu, ${keys} klucz(y)\n`);
  db.close();
}

main().catch((error) => lib.fail(error.stack || error.message));
