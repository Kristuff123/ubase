#!/usr/bin/env node
/**
 * Rotacja klucza głównego (KEK) — przepakowuje DEK-i nowym kluczem.
 *
 *   node scripts/rotate-kek.cjs --new-key-file /sciezka/nowy-kek.txt
 *   node scripts/rotate-kek.cjs --new-key <base64 32B>
 *
 * Stary KEK odczytywany jest ze środowiska (USERBASE_KEK / USERBASE_KEK_FILE) — tym samym,
 * którym aplikacja odszyfrowuje dane. Po sukcesie PODMIEŃ konfigurację aplikacji na nowy klucz
 * i zrestartuj kontener. Sekrety w bazie nie są przepakowywane — zmienia się tylko opakowanie DEK.
 *
 * Jeśli kluczy jest kilka wersji, wszystkie są przepakowywane.
 */
"use strict";

const fs = require("node:fs");
const readline = require("node:readline");
const lib = require("./lib.cjs");

function argValue(flag) {
  const index = process.argv.indexOf(flag);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

async function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const answer = await new Promise((resolve) => rl.question(question, resolve));
  rl.close();
  return answer.trim().toLowerCase() === "tak";
}

async function main() {
  console.log("\nuserbase — rotacja KEK\n");

  let oldKek;
  try {
    oldKek = lib.loadKek();
  } catch (error) {
    lib.fail(`Stary klucz: ${error.message}`);
  }

  let newKekRaw = argValue("--new-key");
  const newKeyFile = argValue("--new-key-file");
  if (!newKekRaw && newKeyFile) {
    if (!fs.existsSync(newKeyFile)) lib.fail(`Brak pliku: ${newKeyFile}`);
    newKekRaw = fs.readFileSync(newKeyFile, "utf8");
  }
  if (!newKekRaw) {
    lib.info("Nie podano nowego klucza — generuję losowy (zapisz go w sejfie!)");
    newKekRaw = require("node:crypto").randomBytes(lib.KEY_LEN).toString("base64");
    console.log(`\nNOWY KEK (base64):\n\n  ${newKekRaw}\n`);
  }

  let newKek;
  try {
    newKek = lib.parseKey(newKekRaw, "--new-key");
  } catch (error) {
    lib.fail(error.message);
  }

  if (oldKek.equals(newKek)) lib.fail("Nowy klucz jest identyczny ze starym — nic by się nie zmieniło.");

  if (!fs.existsSync(lib.dbPath())) lib.fail(`Baza nie istnieje: ${lib.dbPath()}`);
  if (!(await confirm("Zrobiłeś kopię zapasową bazy? Wpisz „tak”, aby kontynuować: "))) {
    lib.fail("Przerwano — najpierw wykonaj kopię (npm run backup).");
  }

  const db = lib.openDb();
  const rows = db.prepare("SELECT version, wrapped_dek FROM crypto_keys ORDER BY version").all();
  if (rows.length === 0) lib.fail("Brak kluczy w bazie — uruchom najpierw db:init.");

  db.transaction(() => {
    for (const row of rows) {
      const aad = `${lib.DEK_AAD}:${row.version}`;
      const dekB64 = lib.decryptWithKey(row.wrapped_dek, oldKek, aad);
      db.prepare("UPDATE crypto_keys SET wrapped_dek = ? WHERE version = ?").run(
        lib.encryptWithKey(dekB64, newKek, aad),
        row.version,
      );
    }
    lib.appendAudit(db, {
      action: "key.rotated",
      actor: { userId: null, name: "cli" },
      summary: `Rotacja KEK: przepakowano ${rows.length} klucz(y) danych`,
      details: { versions: rows.map((row) => row.version) },
    });
  })();

  // Kontrola: odszyfruj każdy DEK nowym kluczem.
  for (const row of rows) {
    const fresh = db.prepare("SELECT wrapped_dek FROM crypto_keys WHERE version = ?").get(row.version);
    lib.decryptWithKey(fresh.wrapped_dek, newKek, `${lib.DEK_AAD}:${row.version}`);
  }

  const chain = lib.verifyAuditChain(db);
  if (!chain.valid) lib.fail(`Łańcuch audytu uszkodzony na wpisie ${chain.brokenAt}`);
  db.close();

  lib.ok(`Przepakowano ${rows.length} klucz(y); weryfikacja nowym KEK przeszła`);
  console.log("\nWAŻNE: zaktualizuj USERBASE_KEK / USERBASE_KEK_FILE i zrestartuj aplikację.");
  console.log("Stary klucz nie jest już potrzebny — zniszcz go zgodnie z procedurą.\n");
}

main().catch((error) => lib.fail(error.stack || error.message));
