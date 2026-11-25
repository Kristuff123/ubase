/**
 * Zarządzanie kluczem danych (DEK) — szyfrowanie kopertowe.
 *
 * DEK jest generowany przy pierwszym uruchomieniu i zapisywany w crypto_keys w formie
 * zaszyfrowanej KEK-iem. Rotacja KEK = przepakowanie DEK-a nowym kluczem głównym.
 */
import { decryptWithKey, encryptWithKey, generateKey, loadKek } from "@/lib/crypto/envelope";
import type { Db } from "@/db";

export type ActiveKey = { version: number; dek: Buffer };

const DEK_AAD = "crypto_keys:dek";

export function getActiveKey(db: Db): ActiveKey {
  const row = db
    .prepare("SELECT version, wrapped_dek FROM crypto_keys WHERE retired_at IS NULL ORDER BY version DESC LIMIT 1")
    .get() as { version: number; wrapped_dek: string } | undefined;

  if (!row) {
    return createInitialKey(db);
  }
  const kek = loadKek();
  return {
    version: row.version,
    dek: Buffer.from(decryptWithKey(row.wrapped_dek, kek, `${DEK_AAD}:${row.version}`), "base64"),
  };
}

function createInitialKey(db: Db): ActiveKey {
  const kek = loadKek();
  const dek = generateKey();
  const version = 1;
  db.prepare("INSERT INTO crypto_keys (version, wrapped_dek, created_at) VALUES (?, ?, ?)").run(
    version,
    encryptWithKey(dek.toString("base64"), kek, `${DEK_AAD}:${version}`),
    Date.now(),
  );
  return { version, dek };
}

/**
 * Rotacja DEK: nowy klucz danych, wszystkie sekrety przepakowane.
 * Wywoływana z CLI, nie z UI. Wymaga podania funkcji przepakowującej rekordy.
 */
export function rotateDek(db: Db, reencrypt: (oldDek: Buffer, newDek: Buffer, newVersion: number) => void): number {
  const kek = loadKek();
  const current = getActiveKey(db);
  const newDek = generateKey();
  const newVersion = current.version + 1;

  const tx = db.transaction(() => {
    reencrypt(current.dek, newDek, newVersion);
    db.prepare("UPDATE crypto_keys SET retired_at = ? WHERE version = ?").run(Date.now(), current.version);
    db.prepare("INSERT INTO crypto_keys (version, wrapped_dek, created_at) VALUES (?, ?, ?)").run(
      newVersion,
      encryptWithKey(newDek.toString("base64"), kek, `${DEK_AAD}:${newVersion}`),
      Date.now(),
    );
  });
  tx();
  return newVersion;
}

/** Rotacja KEK: przepakowuje wszystkie DEK-i nowym kluczem głównym. */
export function rotateKek(db: Db, newKek: Buffer, oldKek: Buffer = loadKek()): void {
  const rows = db.prepare("SELECT version, wrapped_dek FROM crypto_keys").all() as {
    version: number;
    wrapped_dek: string;
  }[];
  const tx = db.transaction(() => {
    for (const row of rows) {
      // Wartość w kolumnie to base64 DEK-a — przepakowujemy ją bez zmiany reprezentacji.
      const dekB64 = decryptWithKey(row.wrapped_dek, oldKek, `${DEK_AAD}:${row.version}`);
      db.prepare("UPDATE crypto_keys SET wrapped_dek = ? WHERE version = ?").run(
        encryptWithKey(dekB64, newKek, `${DEK_AAD}:${row.version}`),
        row.version,
      );
    }
  });
  tx();
}

/** Odszyfrowanie wartości sekretnej kluczem o podanej wersji. */
export function keyForVersion(db: Db, version: number): Buffer {
  const row = db.prepare("SELECT wrapped_dek FROM crypto_keys WHERE version = ?").get(version) as
    | { wrapped_dek: string }
    | undefined;
  if (!row) throw new Error(`Brak klucza w wersji ${version}`);
  return Buffer.from(decryptWithKey(row.wrapped_dek, loadKek(), `${DEK_AAD}:${version}`), "base64");
}
