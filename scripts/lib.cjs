/*
 * Wspólne helpery skryptów operacyjnych (CJS — działają bez buildu i bez TS).
 *
 * Uwaga: format łańcucha audytu MUSI być identyczny jak w src/lib/audit/chain.ts.
 * Każda rozbieżność (kolejność kluczy, brakujący klucz) zerwie weryfikację integralności.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

/* ---------------- ścieżki ---------------- */

function dbPath() {
  return process.env.USERBASE_DB_PATH || path.join(process.cwd(), "data", "userbase.db");
}

/** Znacznik czasu w nazwach plików. Milisekundy, bo dwie kopie w tej samej sekundzie
 *  nadpisałyby się nawzajem — a to cicha utrata kopii. */
function stamp() {
  return new Date().toISOString().replace(/[:.]/g, "-");
}

/**
 * Wolna nazwa bazowa w katalogu: dokłada `-2`, `-3`… dopóki żadna z podanych
 * końcówek nie istnieje. Sprawdza wszystkie końcówki naraz, bo kopia szyfrowana
 * (`*.db.enc`) i nieszyfrowana (`*.db`) mogą pochodzić z różnych przebiegów.
 */
function uniqueBase(dir, baseName, extensions) {
  for (let i = 1; ; i += 1) {
    const name = i === 1 ? baseName : `${baseName}-${i}`;
    if (!extensions.some((ext) => fs.existsSync(path.join(dir, name + ext)))) return name;
  }
}

function migrationsDir() {
  // Ten sam wybór co w aplikacji: dev/build vs obraz standalone.
  const candidates = [path.join(process.cwd(), "src", "db", "migrations"), path.join(process.cwd(), "db", "migrations")];
  for (const candidate of candidates) {
    try {
      if (fs.readdirSync(candidate).length > 0) return candidate;
    } catch {
      // brak katalogu — próbujemy następny
    }
  }
  throw new Error(`Nie znaleziono katalogu migracji (szukano: ${candidates.join(", ")})`);
}

/* ---------------- baza ---------------- */

function openDb(file) {
  let Database;
  try {
    Database = require("better-sqlite3");
  } catch {
    console.error("Brak better-sqlite3. Uruchom: npm install");
    process.exit(1);
  }
  const target = file || dbPath();
  fs.mkdirSync(path.dirname(target), { recursive: true });
  const db = new Database(target);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.pragma("busy_timeout = 5000");
  db.pragma("synchronous = NORMAL");
  return db;
}

function runMigrations(db) {
  const dir = migrationsDir();
  if (!fs.existsSync(dir)) throw new Error(`Brak katalogu migracji: ${dir}`);
  const files = fs
    .readdirSync(dir)
    .filter((f) => f.endsWith(".sql"))
    .sort();
  const current = Number(db.pragma("user_version", { simple: true }) || 0);
  let applied = current;
  for (const file of files) {
    const version = Number(file.slice(0, 3));
    if (!Number.isFinite(version) || version <= current) continue;
    const sql = fs.readFileSync(path.join(dir, file), "utf8");
    db.transaction(() => {
      db.exec(sql);
      db.pragma(`user_version = ${version}`);
    })();
    applied = version;
    console.log(`  migracja ${file} → v${version}`);
  }
  if (applied === current) console.log(`  schemat aktualny (v${current})`);
  return applied;
}

/* ---------------- szyfrowanie kopertowe ---------------- */

const ALGO = "aes-256-gcm";
const IV_LEN = 12;
const KEY_LEN = 32;
const DEK_AAD = "crypto_keys:dek";

function parseKey(raw, source) {
  const buf = Buffer.from(String(raw).trim(), "base64");
  if (buf.length !== KEY_LEN) {
    throw new Error(`Nieprawidłowy klucz (${source}): oczekiwano 32 bajtów, jest ${buf.length}`);
  }
  return buf;
}

function loadKek() {
  const fromEnv = process.env.USERBASE_KEK;
  if (fromEnv && fromEnv.trim()) return parseKey(fromEnv, "USERBASE_KEK");
  const fromFile = process.env.USERBASE_KEK_FILE;
  if (fromFile && fromFile.trim()) {
    if (!fs.existsSync(fromFile.trim())) throw new Error(`Nie można odczytać pliku klucza: ${fromFile}`);
    return parseKey(fs.readFileSync(fromFile.trim(), "utf8"), "USERBASE_KEK_FILE");
  }
  throw new Error("Brak klucza głównego: ustaw USERBASE_KEK lub USERBASE_KEK_FILE");
}

/**
 * Klucz kopii zapasowej: USERBASE_BACKUP_KEY (wartość) albo USERBASE_BACKUP_KEY_FILE (ścieżka).
 * Zwraca null, gdy klucz nie jest skonfigurowany — kopia będzie nieszyfrowana.
 */
function loadBackupKey() {
  const fromEnv = process.env.USERBASE_BACKUP_KEY;
  if (fromEnv && fromEnv.trim()) return parseKey(fromEnv, "USERBASE_BACKUP_KEY");
  const fromFile = process.env.USERBASE_BACKUP_KEY_FILE;
  if (fromFile && fromFile.trim()) {
    if (!fs.existsSync(fromFile.trim())) throw new Error(`Nie można odczytać pliku klucza kopii: ${fromFile}`);
    return parseKey(fs.readFileSync(fromFile.trim(), "utf8"), "USERBASE_BACKUP_KEY_FILE");
  }
  return null;
}

function encryptWithKey(plain, key, aad) {
  const iv = crypto.randomBytes(IV_LEN);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return `v1.${iv.toString("base64")}.${cipher.getAuthTag().toString("base64")}.${ct.toString("base64")}`;
}

function decryptWithKey(payload, key, aad) {
  const parts = String(payload).split(".");
  if (parts.length !== 4 || parts[0] !== "v1") throw new Error("Nieprawidłowy format szyfrogramu");
  const decipher = crypto.createDecipheriv(ALGO, key, Buffer.from(parts[1], "base64"));
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(Buffer.from(parts[2], "base64"));
  return Buffer.concat([decipher.update(Buffer.from(parts[3], "base64")), decipher.final()]).toString("utf8");
}

function getActiveKey(db) {
  const row = db
    .prepare("SELECT version, wrapped_dek FROM crypto_keys WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1")
    .get();
  if (!row) return null;
  return { version: row.version, dek: Buffer.from(decryptWithKey(row.wrapped_dek, loadKek(), `${DEK_AAD}:${row.version}`), "base64") };
}

function ensureInitialKey(db) {
  const existing = db.prepare("SELECT version FROM crypto_keys LIMIT 1").get();
  if (existing) return existing.version;
  const dek = crypto.randomBytes(KEY_LEN);
  const wrapped = encryptWithKey(dek.toString("base64"), loadKek(), `${DEK_AAD}:1`);
  db.prepare("INSERT INTO crypto_keys (version, wrapped_dek, created_at, retired_at) VALUES (1, ?, ?, NULL)").run(
    wrapped,
    Date.now(),
  );
  return 1;
}

/* ---------------- pliki kopii zapasowych ---------------- */

const BACKUP_MAGIC = Buffer.from("UBK1");
const IV_LEN_BACKUP = 12;

/**
 * Szyfrowanie całego pliku kopii: `UBK1 | iv(12) | ciphertext | tag(16)`.
 * Cały plik (nie tylko sekrety w środku) — chroni metadane: nazwiska, loginy,
 * strukturę firmy. Streaming, bo baza może urosnąć ponad wygodny rozmiar bufora.
 */
function encryptFile(input, output, key) {
  const iv = crypto.randomBytes(IV_LEN_BACKUP);
  const cipher = crypto.createCipheriv(ALGO, key, iv);
  const source = fs.createReadStream(input);
  const sink = fs.createWriteStream(output);
  sink.write(Buffer.concat([BACKUP_MAGIC, iv]));
  return new Promise((resolve, reject) => {
    source.on("error", reject);
    sink.on("error", reject);
    cipher.on("error", reject);
    sink.on("finish", () => {
      fs.appendFileSync(output, cipher.getAuthTag());
      resolve();
    });
    source.pipe(cipher).pipe(sink, { end: true });
  });
}

/** Odszyfrowanie pliku kopii. Rzuca przy złym kluczu albo uszkodzonym pliku
 *  (GCM uwierzytelnia całość, więc „cicho złe” dane są niemożliwe). */
function decryptFile(input, output, key) {
  const payload = fs.readFileSync(input);
  if (payload.length < BACKUP_MAGIC.length + IV_LEN_BACKUP + 16) {
    throw new Error("Plik kopii jest za krótki — to nie jest poprawna kopia");
  }
  if (!payload.subarray(0, BACKUP_MAGIC.length).equals(BACKUP_MAGIC)) {
    throw new Error("To nie jest plik kopii userbase (brak nagłówka UBK1)");
  }
  const ivStart = BACKUP_MAGIC.length;
  const iv = payload.subarray(ivStart, ivStart + IV_LEN_BACKUP);
  const tag = payload.subarray(payload.length - 16);
  const data = payload.subarray(ivStart + IV_LEN_BACKUP, payload.length - 16);
  const decipher = crypto.createDecipheriv(ALGO, key, iv);
  decipher.setAuthTag(tag);
  fs.writeFileSync(output, Buffer.concat([decipher.update(data), decipher.final()]));
}

/**
 * Weryfikacja pliku bazy przed uznaniem go za poprawny (kopia albo kandydat do restore):
 * integralność SQLite → łańcuch audytu → czy bieżący KEK otwiera DEK.
 *
 * Ostatni krok jest kluczowy: baza może być technicznie sprawna, ale sekretów nie da się
 * odszyfrować po rotacji KEK. Taki plik wygląda na zdrowy i zawodzi dopiero w aplikacji.
 *
 * Rzuca `Error` z komunikatem po polsku; zwraca podsumowanie do zalogowania.
 */
function verifyDatabaseFile(file) {
  const db = openDb(file);
  try {
    const integrity = db.pragma("integrity_check", { simple: true });
    if (integrity !== "ok") throw new Error(`Baza uszkodzona: ${integrity}`);

    const chain = verifyAuditChain(db);
    if (!chain.valid) {
      throw new Error(`Łańcuch audytu uszkodzony na wpisie ${chain.brokenAt} (${chain.reason})`);
    }

    let key;
    try {
      key = getActiveKey(db);
    } catch (error) {
      throw new Error(`Aktywny klucz główny nie odszyfrowuje klucza danych: ${error.message}`);
    }
    if (!key) throw new Error("W bazie brak klucza danych (crypto_keys jest puste)");

    return { chain, keyVersion: key.version };
  } finally {
    db.close();
  }
}

/* ---------------- audyt (format zgodny z aplikacją) ---------------- */

const GENESIS_HASH = "0".repeat(64);

function sortKeys(value) {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const out = {};
    for (const key of Object.keys(value).sort()) out[key] = sortKeys(value[key]);
    return out;
  }
  return value;
}

function canonicalJson(value) {
  return JSON.stringify(sortKeys(value));
}

function computeEntryHash(prevHash, payload) {
  const canonical = canonicalJson({
    seq: payload.seq,
    at: payload.at,
    actorUserId: payload.actorUserId,
    actorName: payload.actorName,
    actorIp: payload.actorIp,
    action: payload.action,
    entityType: payload.entityType,
    entityId: payload.entityId,
    summary: payload.summary,
    details: payload.details == null ? null : payload.details,
  });
  return crypto.createHash("sha256").update(prevHash).update(canonical).digest("hex");
}

function appendAudit(db, { action, actor = {}, summary, entityType = null, entityId = null, details = null }) {
  const last = db.prepare("SELECT seq, entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1").get();
  const prevHash = last ? last.entry_hash : GENESIS_HASH;
  const seq = (last ? last.seq : 0) + 1;
  const at = Date.now();
  const payload = {
    seq,
    at,
    actorUserId: actor.userId ?? null,
    actorName: actor.name ?? "system",
    actorIp: actor.ip ?? null,
    action,
    entityType,
    entityId,
    summary,
    details,
  };
  const hash = computeEntryHash(prevHash, payload);
  db.prepare(
    `INSERT INTO audit_events
       (seq, at, actor_user_id, actor_name, actor_ip, action, entity_type, entity_id, summary, details_json, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    at,
    payload.actorUserId,
    payload.actorName,
    payload.actorIp,
    action,
    entityType,
    entityId,
    summary,
    details == null ? null : JSON.stringify(details),
    prevHash,
    hash,
  );
  return seq;
}

function verifyAuditChain(db) {
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all();
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) return { valid: false, checked: rows.indexOf(row), brokenAt: row.seq, reason: "prev_hash" };
    const expected = computeEntryHash(prev, {
      seq: row.seq,
      at: row.at,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      actorIp: row.actor_ip,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      details: row.details_json ? JSON.parse(row.details_json) : null,
    });
    if (expected !== row.entry_hash) return { valid: false, checked: rows.indexOf(row), brokenAt: row.seq, reason: "entry_hash" };
    prev = row.entry_hash;
  }
  return { valid: true, checked: rows.length };
}

/* ---------------- hasła ---------------- */

function generatePassword({ length = 16, maxDigits = 4 } = {}) {
  const letters = "abcdefghijklmnopqrstuvwxyz";
  const digits = "0123456789";
  const chars = [];
  const digitCount = 1 + Math.floor(Math.random() * maxDigits);
  for (let i = 0; i < length - digitCount; i += 1) chars.push(letters[crypto.randomInt(letters.length)]);
  for (let i = 0; i < digitCount; i += 1) chars.push(digits[crypto.randomInt(digits.length)]);
  for (let i = chars.length - 1; i > 0; i -= 1) {
    const j = crypto.randomInt(i + 1);
    [chars[i], chars[j]] = [chars[j], chars[i]];
  }
  return chars.join("");
}

/** Argon2id (2) — identyczne parametry jak w aplikacji. */
async function hashPassword(password) {
  const argon = require("@node-rs/argon2");
  return argon.hash(password, { algorithm: 2, memoryCost: 65536, timeCost: 3, parallelism: 1 });
}

/* ---------------- wyjście ---------------- */

/**
 * Oczekiwany błąd operacji (zły klucz, uszkodzona kopia) — w odróżnieniu od błędu
 * programisty. Rzucany, a nie kończący proces, bo `process.exit()` **nie uruchamia
 * bloków `finally`**: skrypty, które sprzątają pliki tymczasowe z sekretami, muszą
 * mieć szansę to zrobić także przy błędzie.
 */
class ScriptError extends Error {}

function abort(message) {
  throw new ScriptError(message);
}

function fail(message) {
  console.error(`\x1b[31m✗ ${message}\x1b[0m`);
  process.exit(1);
}

/** Wspólny finał skryptów: oczekiwany błąd pokazujemy krótko, niespodziewany z tracebackiem. */
function exitWith(error) {
  if (error instanceof ScriptError) fail(error.message);
  fail(error.stack || error.message);
}

function ok(message) {
  console.log(`\x1b[32m✓ ${message}\x1b[0m`);
}

function info(message) {
  console.log(`  ${message}`);
}

module.exports = {
  dbPath,
  stamp,
  uniqueBase,
  migrationsDir,
  openDb,
  runMigrations,
  parseKey,
  loadKek,
  loadBackupKey,
  encryptWithKey,
  decryptWithKey,
  encryptFile,
  decryptFile,
  verifyDatabaseFile,
  getActiveKey,
  ensureInitialKey,
  GENESIS_HASH,
  canonicalJson,
  computeEntryHash,
  appendAudit,
  verifyAuditChain,
  generatePassword,
  hashPassword,
  ScriptError,
  abort,
  fail,
  exitWith,
  ok,
  info,
  KEY_LEN,
  DEK_AAD,
};
