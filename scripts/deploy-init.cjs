#!/usr/bin/env node
/**
 * Pierwsze wdrożenie: generuje klucze, sprawdza konfigurację, wypisuje dalsze kroki.
 *
 *   node scripts/deploy-init.cjs
 *
 * Nie uruchamia kontenerów — przygotowuje pliki, żeby `docker compose up` miał
 * wszystko, czego potrzebuje. Idempotentny: istniejących kluczy nie nadpisuje.
 */
"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const secretsDir = path.join(process.cwd(), "deploy", "secrets");
const envExample = path.join(process.cwd(), "deploy", ".env.example");
const envFile = path.join(process.cwd(), "deploy", ".env");

function ensureKey(name) {
  const target = path.join(secretsDir, name);
  if (fs.existsSync(target)) {
    console.log(`  ${name}: istnieje, pomijam`);
    return false;
  }
  fs.writeFileSync(target, crypto.randomBytes(32).toString("base64") + "\n", { mode: 0o600 });
  console.log(`  ${name}: wygenerowano`);
  return true;
}

function main() {
  console.log("\nuserbase — przygotowanie wdrożenia\n");

  fs.mkdirSync(secretsDir, { recursive: true });
  const createdKek = ensureKey("kek");
  const createdBackup = ensureKey("backup_key");

  if (!fs.existsSync(envFile) && fs.existsSync(envExample)) {
    fs.copyFileSync(envExample, envFile);
    console.log("  deploy/.env: utworzono z przykładu — uzupełnij USERBASE_HOST");
  } else if (fs.existsSync(envFile)) {
    console.log("  deploy/.env: istnieje, pomijam");
  }

  const envContent = fs.existsSync(envFile) ? fs.readFileSync(envFile, "utf8") : "";
  const host = /^USERBASE_HOST=(.+)$/m.exec(envContent)?.[1]?.trim();

  console.log("\nDalsze kroki:\n");
  if (!host || host === "userbase.example.com") {
    console.log("  1. Ustaw domenę w deploy/.env:  USERBASE_HOST=twoja.domena.pl");
    console.log("  2. docker compose --env-file deploy/.env up -d --build");
  } else {
    console.log("  1. docker compose --env-file deploy/.env up -d --build");
  }
  console.log("  3. docker compose --env-file deploy/.env exec app node scripts/db-init.cjs");
  console.log("     (wypisze hasło startowe admina — zapisz je)");

  if (createdKek || createdBackup) {
    console.log("\n⚠  NOWE KLUCZE — zapisz je w sejfie POZA tym serwerem:");
    if (createdKek) console.log(`     deploy/secrets/kek`);
    if (createdBackup) console.log(`     deploy/secrets/backup_key`);
    console.log("   Utrata klucza KEK = utrata wszystkich sekretów w bazie.\n");
  } else {
    console.log("");
  }
}

try {
  main();
} catch (error) {
  console.error(`\n✗ ${error.message}\n`);
  process.exit(1);
}
