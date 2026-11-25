#!/usr/bin/env node
/**
 * Kopia zapasowa bazy: spójny snapshot SQLite (VACUUM INTO) + opcjonalne szyfrowanie.
 *
 *   USERBASE_KEK=... node scripts/backup.cjs [katalog]
 *   USERBASE_BACKUP_KEY=...       ← osobny klucz do szyfrowania kopii (zalecane)
 *   USERBASE_BACKUP_KEY_FILE=...  ← albo ścieżka do pliku z kluczem (Docker secrets)
 *
 * Bez USERBASE_BACKUP_KEY kopia jest nieszyfrowana (ale i tak bezużyteczna bez KEK,
 * bo sekrety w środku są zaszyfrowane kluczem danych). Szyfrowanie całego pliku chroni
 * dodatkowo metadane: nazwiska, loginy, strukturę firmy.
 *
 * Kolejność ma znaczenie: najpierw weryfikacja kopii, potem uznanie jej za gotową.
 * Plik jawny (przed szyfrowaniem) żyje wyłącznie w katalogu tymczasowym usuwanym
 * w `finally`, a nieudana kopia nieszyfrowana jest kasowana — w katalogu kopii nie
 * może zostać plik, którego nikt nie sprawdził.
 */
"use strict";

const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const lib = require("./lib.cjs");

/** Retencja: co najmniej 1, bo 0 (albo literówka w zmiennej) usuwałoby świeżą kopię. */
function keepCount() {
  const raw = Number(process.env.USERBASE_BACKUP_KEEP || 14);
  return Number.isFinite(raw) && raw >= 1 ? Math.floor(raw) : 14;
}

const KEEP_BACKUPS = keepCount();

/** Weryfikuje bazę pod podaną ścieżką i loguje wynik. Rzuca `ScriptError`, gdy plik jest zły. */
function verify(file, label) {
  let result;
  try {
    result = lib.verifyDatabaseFile(file);
  } catch (error) {
    lib.abort(`${label} nie przeszła weryfikacji: ${error.message}`);
  }
  lib.ok(`${label}: integralność OK, audyt OK (${result.chain.checked} wpisów), DEK v${result.keyVersion}`);
}

/**
 * Spójny snapshot bazy. `VACUUM INTO` produkuje bazę w jednym pliku, bez WAL-a,
 * więc wynik jest kompletny sam w sobie (sprawdzone: plik nie ma sidecara `-wal`
 * i zawiera wiersze, które przed snapshotem żyły jeszcze w WAL-u aplikacji).
 * Nie blokuje zapisów aplikacji.
 */
function writeSnapshot(targetPath) {
  const db = lib.openDb();
  try {
    db.exec(`VACUUM INTO '${targetPath.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

async function backup(targetDir) {
  fs.mkdirSync(targetDir, { recursive: true });

  if (!fs.existsSync(lib.dbPath())) lib.abort(`Baza nie istnieje: ${lib.dbPath()}`);

  // Milisekundy + sufiks przy kolizji: dwie kopie w tej samej sekundzie nie mogą
  // się nadpisać. `VACUUM INTO` odmawia zapisu do istniejącego pliku, więc kolizja
  // zakończyłaby się błędem — albo, przy kopii szyfrowanej, cichym nadpisaniem.
  const baseName = lib.uniqueBase(targetDir, `userbase-${lib.stamp()}`, [".db", ".db.enc"]);

  // Snapshot powstaje w katalogu tymczasowym, nie obok docelowego pliku — nie zaśmieca
  // katalogu kopii i nie wygląda jak kopia dla retencji.
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "userbase-backup-"));
  try {
    const backupKey = lib.loadBackupKey();
    let outputPath;

    if (backupKey) {
      // Plik jawny nie może trafić do katalogu kopii — metadane (nazwiska, loginy) mają
      // być zaszyfrowane razem z resztą.
      const rawPath = path.join(workDir, "snapshot.db");
      writeSnapshot(rawPath);

      // Weryfikacja PRZED szyfrowaniem: taniej sprawdzić plik jawny niż odszyfrowywać
      // go z powrotem, a błąd i tak trzeba zgłosić przed zapisem kopii.
      verify(rawPath, "Snapshot");

      outputPath = path.join(targetDir, `${baseName}.db.enc`);
      await lib.encryptFile(rawPath, outputPath, backupKey);
      lib.ok(`Zaszyfrowano AES-256-GCM: ${outputPath}`);

      // Kopia zaszyfrowana też musi być sprawdzona — to ona jest produktem.
      // Odszyfrowanie dowodzi, że klucz i tag GCM są poprawne.
      const roundTrip = path.join(workDir, "round-trip.db");
      lib.decryptFile(outputPath, roundTrip, backupKey);
      verify(roundTrip, "Kopia zaszyfrowana");
    } else {
      // Bez szyfrowania `VACUUM INTO` pisze wprost do pliku docelowego — snapshot jest
      // już kompletną bazą, więc nie ma czego kopiować ani czym ryzykować utraty WAL-a.
      outputPath = path.join(targetDir, `${baseName}.db`);
      writeSnapshot(outputPath);
      try {
        verify(outputPath, "Snapshot");
      } catch (error) {
        // Nieudana kopia nie może zostać w katalogu — wyglądałaby jak poprawna.
        fs.rmSync(outputPath, { force: true });
        throw error;
      }
      lib.info("USERBASE_BACKUP_KEY nie ustawiony — kopia bez szyfrowania pliku");
    }

    // Retencja: zostaw N najnowszych. Sortowanie po znaczniku czasu rosnąco,
    // a przy remisie po numerze sufiksu (`-2` przed `-10`).
    const files = fs
      .readdirSync(targetDir)
      .filter((f) => f.startsWith("userbase-") && (f.endsWith(".db") || f.endsWith(".db.enc")))
      .sort((a, b) => {
        const [aBase, aSuffix] = splitSuffix(a);
        const [bBase, bSuffix] = splitSuffix(b);
        return aBase === bBase ? aSuffix - bSuffix : aBase < bBase ? -1 : 1;
      })
      .reverse();
    for (const stale of files.slice(KEEP_BACKUPS)) {
      fs.unlinkSync(path.join(targetDir, stale));
      lib.info(`Usunięto starą kopię: ${stale}`);
    }

    const size = fs.statSync(outputPath).size;
    console.log(`\nGotowe: ${outputPath} (${(size / 1024).toFixed(0)} kB)\n`);
  } finally {
    fs.rmSync(workDir, { recursive: true, force: true });
  }
}

/**
 * Rozbija `userbase-2026-01-01T00-00-00-000Z-2.db.enc` na bazę i numer porządkowy.
 * Bez tego `…-10` sortowałoby się przed `…-9` przy porównywaniu napisów.
 */
function splitSuffix(fileName) {
  const match = /^(.*?)(?:-(\d+))?\.db(?:\.enc)?$/.exec(fileName);
  if (!match) return [fileName, 1];
  return [match[1], match[2] ? Number(match[2]) : 1];
}

async function main() {
  const targetDir = path.resolve(
    process.argv[2] || process.env.USERBASE_BACKUP_DIR || path.join(process.cwd(), "backups"),
  );
  try {
    await backup(targetDir);
  } catch (error) {
    lib.exitWith(error);
  }
}

main().catch((error) => lib.fail(error.stack || error.message));
