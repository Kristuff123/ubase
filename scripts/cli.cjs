#!/usr/bin/env node
/**
 * CLI operacyjne userbase.
 *
 *   node scripts/cli.cjs status
 *   node scripts/cli.cjs audit:verify
 *   node scripts/cli.cjs user:list
 *   node scripts/cli.cjs user:add <login> "<Imię Nazwisko>" [admin|operator|audytor]
 *   node scripts/cli.cjs user:reset <login>
 *   node scripts/cli.cjs worker:purge <id> --yes
 *   node scripts/cli.cjs units:import <plik.csv>        # typ;nazwa;numer
 *   node scripts/cli.cjs rekey:dek                      # nowa wersja DEK
 */
"use strict";

const fs = require("node:fs");
const lib = require("./lib.cjs");

function usage() {
  console.log(`
userbase CLI

  status                        stan bazy, kluczy i audytu
  audit:verify                  przelicza łańcuch hashy
  user:list                     lista kont aplikacji
  user:add <login> "<nazwa>" [rola]   utworzyć konto (hasło wygenerowane)
  user:reset <login>            zresetować hasło (wymuszona zmiana)
  worker:purge <id> --yes       TRWALE usuwa pracownika i jego dostępy
  units:import <plik.csv>       import jednostek: typ;nazwa;numer
  rekey:dek                     nowa wersja klucza danych (przepakowanie sekretów)
`);
}

function requireDb() {
  if (!fs.existsSync(lib.dbPath())) lib.fail(`Baza nie istnieje: ${lib.dbPath()} — uruchom npm run db:init`);
  return lib.openDb();
}

async function main() {
  const [command, ...args] = process.argv.slice(2);
  if (!command || command === "help" || command === "--help") return usage();

  switch (command) {
    case "status": {
      const db = requireDb();
      const stat = (table) => db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get().c;
      const chain = lib.verifyAuditChain(db);
      const kekOk = (() => {
        try {
          lib.getActiveKey(db);
          return true;
        } catch {
          return false;
        }
      })();
      console.log(`\nBaza:        ${lib.dbPath()}`);
      console.log(`Schemat:     v${db.pragma("user_version", { simple: true })}`);
      console.log(`Konta:       ${stat("app_users")}`);
      console.log(`Pracownicy:  ${stat("workers")} (aktywni: ${db.prepare("SELECT COUNT(*) AS c FROM workers WHERE status='aktywny'").get().c})`);
      console.log(`Dostępy:     ${stat("accesses")} (aktywne: ${db.prepare("SELECT COUNT(*) AS c FROM accesses WHERE status='aktywny'").get().c})`);
      console.log(`Sekrety:     ${db.prepare("SELECT COUNT(*) AS c FROM access_fields WHERE value_enc IS NOT NULL").get().c} zaszyfrowanych pól`);
      console.log(`Audyt:       ${chain.checked} wpisów, łańcuch ${chain.valid ? "OK" : `USZKODZONY @ ${chain.brokenAt}`}`);
      console.log(`Klucz główny: ${kekOk ? "wczytany, DEK odszyfrowany" : "BŁĄD — sprawdź USERBASE_KEK"}\n`);
      db.close();
      break;
    }

    case "audit:verify": {
      const db = requireDb();
      const chain = lib.verifyAuditChain(db);
      if (chain.valid) lib.ok(`Łańcuch poprawny: ${chain.checked} wpisów`);
      else lib.fail(`Łańcuch USZKODZONY na wpisie ${chain.brokenAt} (${chain.reason})`);
      lib.appendAudit(db, {
        action: "audit.verified",
        actor: { userId: null, name: "cli" },
        summary: `Weryfikacja łańcucha z CLI: ${chain.valid ? "poprawny" : "uszkodzony"}`,
        details: { checked: chain.checked, valid: chain.valid },
      });
      db.close();
      break;
    }

    case "user:list": {
      const db = requireDb();
      const rows = db
        .prepare("SELECT username, display_name, role, is_active, totp_enabled, last_login_at FROM app_users ORDER BY created_at")
        .all();
      console.log("\nlogin              rola       aktywny  2FA   ostatnie logowanie");
      for (const row of rows) {
        console.log(
          `${row.username.padEnd(18)} ${row.role.padEnd(10)} ${(row.is_active ? "tak" : "nie").padEnd(8)} ${
            row.totp_enabled ? "tak" : "—"
          }   ${row.last_login_at ? new Date(row.last_login_at).toISOString() : "nigdy"}`,
        );
      }
      console.log();
      db.close();
      break;
    }

    case "user:add": {
      const [username, displayName, role = "operator"] = args;
      if (!username || !displayName) lib.fail("Użycie: user:add <login> \"<Imię Nazwisko>\" [rola]");
      if (!/^[a-z0-9._-]{3,32}$/.test(username)) lib.fail("Login: 3–32 znaki, małe litery, cyfry, . _ -");
      if (!["admin", "operator", "audytor"].includes(role)) lib.fail("Rola: admin | operator | audytor");

      const db = requireDb();
      if (db.prepare("SELECT id FROM app_users WHERE username = ? COLLATE NOCASE").get(username)) {
        lib.fail(`Login ${username} już istnieje`);
      }
      const password = lib.generatePassword({ length: 20, maxDigits: 4 });
      const hash = await lib.hashPassword(password);
      const id = db
        .prepare(
          `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
           VALUES (?, ?, ?, ?, 1, ?)`,
        )
        .run(username, displayName, role, hash, Date.now()).lastInsertRowid;
      lib.appendAudit(db, {
        action: "user.created",
        actor: { userId: null, name: "cli" },
        summary: `Utworzono konto ${username} (${role}) przez CLI`,
        entityType: "app_user",
        entityId: Number(id),
      });
      db.close();
      lib.ok(`Konto ${username} (${role}) utworzone`);
      console.log(`\n  Hasło startowe: ${password}\n  (wymuszona zmiana przy pierwszym logowaniu)\n`);
      break;
    }

    case "user:reset": {
      const [username] = args;
      if (!username) lib.fail("Użycie: user:reset <login>");
      const db = requireDb();
      const user = db.prepare("SELECT id, username FROM app_users WHERE username = ? COLLATE NOCASE").get(username);
      if (!user) lib.fail(`Brak konta ${username}`);
      const password = lib.generatePassword({ length: 20, maxDigits: 4 });
      const hash = await lib.hashPassword(password);
      db.prepare("UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hash, user.id);
      db.prepare("DELETE FROM sessions WHERE user_id = ?").run(user.id);
      lib.appendAudit(db, {
        action: "auth.password_changed",
        actor: { userId: null, name: "cli" },
        summary: `Reset hasła ${username} przez CLI (sesje unieważnione)`,
        entityType: "app_user",
        entityId: user.id,
      });
      db.close();
      lib.ok(`Hasło ${username} zresetowane, sesje unieważnione`);
      console.log(`\n  Nowe hasło: ${password}\n`);
      break;
    }

    case "worker:purge": {
      const [idRaw] = args;
      const confirmed = args.includes("--yes");
      if (!idRaw) lib.fail("Użycie: worker:purge <id> --yes");
      const id = Number(idRaw);
      if (!Number.isInteger(id)) lib.fail("ID musi być liczbą");
      const db = requireDb();
      const worker = db.prepare("SELECT first_name, last_name FROM workers WHERE id = ?").get(id);
      if (!worker) lib.fail(`Brak pracownika #${id}`);

      if (!confirmed) {
        lib.fail(
          `To TRWAŁE usunięcie ${worker.first_name} ${worker.last_name} wraz z dostępami. ` +
            "Wpis w audycie pozostanie (bez danych osobowych po usunięciu). Dodaj --yes, aby potwierdzić.",
        );
      }
      db.transaction(() => {
        const accessIds = db.prepare("SELECT id FROM accesses WHERE worker_id = ?").all(id);
        for (const access of accessIds) db.prepare("DELETE FROM access_fields WHERE access_id = ?").run(access.id);
        db.prepare("DELETE FROM accesses WHERE worker_id = ?").run(id);
        db.prepare("DELETE FROM record_history WHERE entity_type = 'worker' AND entity_id = ?").run(id);
        for (const access of accessIds) {
          db.prepare("DELETE FROM record_history WHERE entity_type = 'access' AND entity_id = ?").run(access.id);
        }
        db.prepare("DELETE FROM workers WHERE id = ?").run(id);
        lib.appendAudit(db, {
          action: "worker.purged",
          actor: { userId: null, name: "cli" },
          summary: `Trwale usunięto pracownika #${id} (${accessIds.length} dostępów)`,
          entityType: "worker",
          entityId: id,
          details: { accessCount: accessIds.length, reason: "RODO — prawo do usunięcia" },
        });
      })();
      db.close();
      lib.ok(`Pracownik #${id} usunięty trwale (audyt zachowany)`);
      break;
    }

    case "units:import": {
      const [file] = args;
      if (!file) lib.fail("Użycie: units:import <plik.csv>  (kolumny: typ;nazwa;numer)");
      if (!fs.existsSync(file)) lib.fail(`Brak pliku ${file}`);
      const lines = fs.readFileSync(file, "utf8").split(/\r?\n/).filter((line) => line.trim());
      const db = requireDb();
      const validTypes = ["region", "zaklad", "sklep", "biuro"];
      let added = 0;
      let skipped = 0;
      db.transaction(() => {
        for (const line of lines) {
          const [typeRaw, name, number] = line.split(";").map((part) => (part || "").trim());
          const type = (typeRaw || "sklep").toLowerCase();
          if (!validTypes.includes(type) || !name) {
            skipped += 1;
            continue;
          }
          const exists = db
            .prepare("SELECT id FROM org_units WHERE type = ? AND name = ? COLLATE NOCASE")
            .get(type, name);
          if (exists) {
            skipped += 1;
            continue;
          }
          db.prepare("INSERT INTO org_units (type, name, number, created_at) VALUES (?, ?, ?, ?)").run(
            type,
            name,
            number || null,
            Date.now(),
          );
          added += 1;
        }
        lib.appendAudit(db, {
          action: "admin.org_unit.created",
          actor: { userId: null, name: "cli" },
          summary: `Import jednostek z pliku ${file}: dodano ${added}, pominięto ${skipped}`,
          details: { file, added, skipped },
        });
      })();
      db.close();
      lib.ok(`Dodano ${added} jednostek, pominięto ${skipped}`);
      break;
    }

    case "rekey:dek": {
      const db = requireDb();
      const active = lib.getActiveKey(db);
      if (!active) lib.fail("Brak aktywnego DEK — uruchom db:init");
      const { version } = active;

      const crypto = require("node:crypto");
      const newDek = crypto.randomBytes(lib.KEY_LEN);
      const newVersion = version + 1;
      const kek = lib.loadKek();

      // Klucz per wersja — pole mogło zostać zaszyfrowane starszym DEK-iem.
      const dekCache = new Map([[version, active.dek]]);
      const dekFor = (fieldVersion) => {
        const wanted = fieldVersion ?? 1;
        if (dekCache.has(wanted)) return dekCache.get(wanted);
        const row = db.prepare("SELECT wrapped_dek FROM crypto_keys WHERE version = ?").get(wanted);
        if (!row) lib.fail(`Brak klucza w wersji ${wanted} — nie można przepakować sekretu`);
        const dek = Buffer.from(lib.decryptWithKey(row.wrapped_dek, kek, `${lib.DEK_AAD}:${wanted}`), "base64");
        dekCache.set(wanted, dek);
        return dek;
      };

      db.transaction(() => {
        db.prepare("UPDATE crypto_keys SET retired_at = ? WHERE retired_at IS NULL").run(Date.now());
        db.prepare("INSERT INTO crypto_keys (version, wrapped_dek, created_at) VALUES (?, ?, ?)").run(
          newVersion,
          lib.encryptWithKey(newDek.toString("base64"), kek, `${lib.DEK_AAD}:${newVersion}`),
          Date.now(),
        );

        // Przepakowanie istniejących sekretów: odszyfruj kluczem właściwej wersji, zaszyfruj nowym.
        const fields = db
          .prepare("SELECT id, access_id, field_key, value_enc, key_version FROM access_fields WHERE value_enc IS NOT NULL")
          .all();
        let reencrypted = 0;
        for (const field of fields) {
          const access = db.prepare("SELECT worker_id FROM accesses WHERE id = ?").get(field.access_id);
          const aad = `access:${access.worker_id}:${field.access_id}:${field.field_key}`;
          const plain = lib.decryptWithKey(field.value_enc, dekFor(field.key_version), aad);
          db.prepare("UPDATE access_fields SET value_enc = ?, key_version = ? WHERE id = ?").run(
            lib.encryptWithKey(plain, newDek, aad),
            newVersion,
            field.id,
          );
          reencrypted += 1;
        }

        const totp = db.prepare("SELECT id, totp_secret_enc FROM app_users WHERE totp_secret_enc IS NOT NULL").all();
        for (const user of totp) {
          const plain = lib.decryptWithKey(user.totp_secret_enc, active.dek, `app_user:${user.id}:totp`);
          db.prepare("UPDATE app_users SET totp_secret_enc = ? WHERE id = ?").run(
            lib.encryptWithKey(plain, newDek, `app_user:${user.id}:totp`),
            user.id,
          );
        }

        // Opakowania DEK też przechodzą na nowy klucz danych — kolejne rotacje będą spójne.
        lib.appendAudit(db, {
          action: "key.rotated",
          actor: { userId: null, name: "cli" },
          summary: `Rotacja DEK: v${version} → v${newVersion}, przepakowano ${reencrypted} sekretów`,
          details: { from: version, to: newVersion, reencrypted, totpAccounts: totp.length },
        });
      })();
      db.close();
      lib.ok(`Nowy DEK v${newVersion}; klucz v${version} wycofany (dane odszyfrowywalne w obu wersjach)`);
      break;
    }

    default:
      lib.fail(`Nieznana komenda: ${command}`);
  }
}

main().catch((error) => lib.fail(error.stack || error.message));
