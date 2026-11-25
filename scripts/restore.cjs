#!/usr/bin/env node
/**
 * Odtworzenie bazy z kopii zapasowej.
 *
 *   node scripts/restore.cjs backups/userbase-....db.enc
 *   node scripts/restore.cjs backups/userbase-....db
 *
 * Zaszyfrowana kopia wymaga tego samego klucza, którym ją utworzono
 * (USERBASE_BACKUP_KEY lub USERBASE_BACKUP_KEY_FILE).
 * Przed podmianą bazy:
 *   1. weryfikuje integralność SQLite i łańcuch audytu,
 *   2. sprawdza, że aktywny KEK odszyfrowuje DEK (inaczej dane sekretów byłyby nieczytelne),
 *   3. robi kopię obecnej bazy jako `*.before-restore`.
 *
 * Kopia zaszyfrowana jest odszyfrowywana do katalogu tymczasowego, który jest usuwany
 * także przy błędzie. Odszyfrowana baza zawiera wszystkie sekrety, więc nie może zostać
 * na dysku obok kopii tylko dlatego, że walidacja nie przeszła. Dlatego błędy
 * oczekiwane rzucamy (`lib.abort`), a nie kończymy procesu od razu — `process.exit()`
 * nie uruchamia `finally`.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("./lib.cjs");

async function restore(source) {
  const sourcePath = path.resolve(source);
  if (!fs.existsSync(sourcePath)) lib.abort(`Brak pliku: ${source}`);

  let workDir = null;
  let dbFile = sourcePath;

  try {
    if (source.endsWith(".enc")) {
      const backupKey = lib.loadBackupKey();
      if (!backupKey) lib.abort("Kopia jest zaszyfrowana — ustaw USERBASE_BACKUP_KEY lub USERBASE_BACKUP_KEY_FILE");

      workDir = fs.mkdtempSync(path.join(os.tmpdir(), "userbase-restore-"));
      const decrypted = path.join(workDir, "restored.db");
      try {
        lib.decryptFile(sourcePath, decrypted, backupKey);
      } catch {
        lib.abort("Nie udało się odszyfrować kopii — zły klucz albo plik uszkodzony");
      }
      dbFile = decrypted;
      lib.ok("Odszyfrowano kopię → katalog tymczasowy");
    }

    // 1–2. Integralność, łańcuch audytu i otwarcie DEK bieżącym KEK.
    let verified;
    try {
      verified = lib.verifyDatabaseFile(dbFile);
    } catch (error) {
      lib.abort(`Kopia nie przeszła weryfikacji: ${error.message}`);
    }
    lib.ok("Integralność SQLite OK");
    lib.ok(`Łańcuch audytu OK (${verified.chain.checked} wpisów)`);
    lib.ok(`DEK v${verified.keyVersion} odszyfrowany bieżącym KEK`);

    // 3. Podmiana z zabezpieczeniem obecnej bazy.
    const stamp = lib.stamp();
    const target = lib.dbPath();
    fs.mkdirSync(path.dirname(target), { recursive: true });
    if (fs.existsSync(target)) {
      const backupPath = `${target}.before-restore-${stamp}`;
      for (const suffix of ["", "-wal", "-shm"]) {
        if (fs.existsSync(target + suffix)) fs.copyFileSync(target + suffix, backupPath + suffix);
      }
      lib.ok(`Obecna baza zabezpieczona: ${backupPath}`);
    }
    for (const suffix of ["-wal", "-shm"]) {
      const sidecar = target + suffix;
      if (fs.existsSync(sidecar)) fs.unlinkSync(sidecar);
    }
    fs.copyFileSync(dbFile, target);
    lib.ok(`Baza odtworzona: ${target}`);

    const restored = lib.openDb(target);
    const workers = restored.prepare("SELECT COUNT(*) AS c FROM workers").get().c;
    const accesses = restored.prepare("SELECT COUNT(*) AS c FROM accesses").get().c;
    const users = restored.prepare("SELECT COUNT(*) AS c FROM app_users").get().c;
    restored.close();
    console.log(`\nStan po odtworzeniu: ${workers} pracowników, ${accesses} dostępów, ${users} kont\n`);
    console.log("Zrestartuj aplikację, aby otworzyła nowy plik bazy.\n");
  } finally {
    // Odszyfrowana kopia zawiera wszystkie sekrety — nie zostawiamy jej nigdy.
    if (workDir) fs.rmSync(workDir, { recursive: true, force: true });
  }
}

async function main() {
  const source = process.argv[2];
  if (!source) lib.fail("Użycie: node scripts/restore.cjs <plik-kopii>");
  try {
    await restore(source);
  } catch (error) {
    lib.exitWith(error);
  }
}

main().catch((error) => lib.fail(error.stack || error.message));
