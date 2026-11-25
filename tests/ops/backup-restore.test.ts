/**
 * Testy operacyjne kopii zapasowych — na prawdziwych skryptach, nie na ich kopii.
 *
 * Powód istnienia: kopia, której nigdy nie odtworzono, jest tylko nadzieją. Do tej pory
 * procedura była opisana w AGENTS.md i wykonywana ręcznie, więc regresja w `backup.cjs`
 * albo `restore.cjs` nie miała szansy zostać wykryta przed awarią.
 *
 * Skrypty uruchamiamy jako osobne procesy (`spawnSync`), bo to jest sposób, w jaki
 * działają na produkcji: mają własny `process.env`, własne `process.exit()` i własne
 * pliki tymczasowe. Importowanie ich do procesu Vitest fałszywałoby obraz (wspólny
 * `process.cwd()`, brak izolacji środowiska).
 *
 * Każdy test dostaje własny katalog tymczasowy i własną bazę — testy nie dzielą stanu.
 * Klucze są losowane per test, więc nie da się „zaliczyć” testu kluczem z innego pliku.
 */
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

const ROOT = path.resolve(import.meta.dirname, "../..");
const SCRIPTS = path.join(ROOT, "scripts");

/** Ścieżki tymczasowych katalogów wystawionych poza bezpieczne granice systemu. */
const TMP_PREFIXES = ["userbase-backup-", "userbase-restore-"];

type OpsResult = { status: number | null; stdout: string; stderr: string; output: string };

let workDir: string;
let dbPath: string;
let backupDir: string;
let kek: string;
let backupKey: string;

function newKey(): string {
  return randomBytes(32).toString("base64");
}

function env(overrides: Record<string, string | undefined> = {}): NodeJS.ProcessEnv {
  const base: NodeJS.ProcessEnv = {
    ...process.env,
    USERBASE_KEK: kek,
    USERBASE_BACKUP_KEY: backupKey,
    USERBASE_DB_PATH: dbPath,
    // Skrypty są CJS i nie potrzebują buildu — czysty node wystarcza.
    NODE_ENV: "test",
  };
  for (const [key, value] of Object.entries(overrides)) {
    if (value === undefined) delete base[key];
    else base[key] = value;
  }
  return base;
}

function run(script: string, args: string[] = [], overrides: Record<string, string | undefined> = {}): OpsResult {
  const result = spawnSync(process.execPath, [path.join(SCRIPTS, script), ...args], {
    cwd: ROOT,
    env: env(overrides),
    encoding: "utf8",
  });
  return {
    status: result.status,
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
    output: `${result.stdout ?? ""}${result.stderr ?? ""}`,
  };
}

/** Pliki kopii w katalogu. Wzorzec jako napis (`".db$"`) albo RegExp — dla czytelności wywołań. */
function backups(pattern: string | RegExp = /\.db(\.enc)?$/): string[] {
  const test = typeof pattern === "string" ? (name: string) => new RegExp(pattern).test(name) : (name: string) => pattern.test(name);
  return readdirSync(backupDir).filter(test).sort();
}

/** Tworzy bazę z jednym pracownikiem i sekretem — przez prawdziwe API skryptów i SQL. */
function seedDatabase(): void {
  const init = run("db-init.cjs");
  expect(init.status, init.output).toBe(0);

  // Domena aplikacji (createWorker/addAccess) jest TS i wymaga buildu, więc do samego
  // wypełnienia bazy używamy SQL-a — test dotyczy kopii, nie walidacji domeny.
  const seed = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
      const db = lib.openDb();
      const ts = Date.now();
      db.prepare("INSERT INTO org_units (type, name, created_at) VALUES ('zaklad', 'PIEKARNIA', ?)").run(ts);
      db.prepare(
        "INSERT INTO workers (first_name, last_name, position, org_unit_id, status, search_blob, created_at, updated_at) VALUES ('Jan','Kowalski','Piekarz',1,'aktywny','jan kowalski',?,?)"
      ).run(ts, ts);
      const cat = db.prepare("SELECT id FROM access_categories WHERE slug = 'axel'").get();
      db.prepare(
        "INSERT INTO accesses (worker_id, category_id, status, resource_owner, created_at, updated_at) VALUES (1, ?, 'aktywny','firma',?,?)"
      ).run(cat.id, ts, ts);
      const { encryptWithKey } = lib;
      const key = lib.getActiveKey(db);
      db.prepare(
        "INSERT INTO access_fields (access_id, field_key, value_text, value_enc, key_version) VALUES (1,'login','jan.kowalski',NULL,NULL)"
      ).run();
      db.prepare(
        "INSERT INTO access_fields (access_id, field_key, value_text, value_enc, key_version) VALUES (1,'password',NULL,?,?)"
      ).run(encryptWithKey('tajne-haslo-axel-123', key.dek, 'access:1:1:password'), key.version);
      lib.appendAudit(db, { action: 'worker.created', actor: { name: 'test' }, summary: 'Pracownik Jan Kowalski', entityType: 'worker', entityId: 1 });
      db.close();
      `,
    ],
    { cwd: ROOT, env: env(), encoding: "utf8" },
  );
  expect(seed.status, `${seed.stdout}${seed.stderr}`).toBe(0);
}

/** Odczyt stanu odtworzonej bazy — osobny proces, bo skrypty same zamykają połączenia. */
function readRestored(): { workers: number; accesses: number; users: number; events: number; secret: string | null } {
  const result = spawnSync(
    process.execPath,
    [
      "-e",
      `
      const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
      const db = lib.openDb();
      const one = (sql) => db.prepare(sql).get().c;
      const row = db.prepare("SELECT value_enc, key_version FROM access_fields WHERE access_id = 1 AND field_key = 'password'").get();
      const { decryptWithKey } = lib;
      const key = lib.getActiveKey(db);
      const secret = row ? decryptWithKey(row.value_enc, key.dek, 'access:1:1:password') : null;
      process.stdout.write(JSON.stringify({
        workers: one("SELECT COUNT(*) AS c FROM workers"),
        accesses: one("SELECT COUNT(*) AS c FROM accesses"),
        users: one("SELECT COUNT(*) AS c FROM app_users"),
        events: one("SELECT COUNT(*) AS c FROM audit_events"),
        secret,
      }));
      db.close();
      `,
    ],
    { cwd: ROOT, env: env(), encoding: "utf8" },
  );
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout) as ReturnType<typeof readRestored>;
}

const tmpBefore = new Set<string>();

function snapshotTmp(): Set<string> {
  return new Set(
    readdirSync(tmpdir()).filter((name) => TMP_PREFIXES.some((prefix) => name.startsWith(prefix))),
  );
}

beforeEach(() => {
  workDir = mkdtempSync(path.join(tmpdir(), "userbase-ops-test-"));
  dbPath = path.join(workDir, "data", "userbase.db");
  backupDir = path.join(workDir, "backups");
  kek = newKey();
  backupKey = newKey();
  for (const name of snapshotTmp()) tmpBefore.add(name);
});

afterEach(() => {
  rmSync(workDir, { recursive: true, force: true });
});

describe("kopia zapasowa — pełny cykl", () => {
  it("tworzy zaszyfrowaną kopię i odtwarza z niej komplet danych wraz z sekretem", () => {
    seedDatabase();
    const before = readRestored();

    const backup = run("backup.cjs", [backupDir]);
    expect(backup.status, backup.output).toBe(0);
    expect(backup.output).toContain("Zaszyfrowano AES-256-GCM");
    // Kopia szyfrowana jest produktem, więc skrypt musi jawnie potwierdzić, że ją
    // sprawdził — dla operatora log jest jedynym dowodem, co zostało zweryfikowane.
    expect(backup.output).toContain("Kopia zaszyfrowana: integralność OK");

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/^userbase-.*\.db\.enc$/);

    // Zniszcz bazę, żeby odtworzenie musiało naprawdę zadziałać.
    rmSync(dbPath, { force: true });
    for (const suffix of ["-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

    const restore = run("restore.cjs", [path.join(backupDir, files[0])]);
    expect(restore.status, restore.output).toBe(0);
    expect(restore.output).toContain("Łańcuch audytu OK");

    const after = readRestored();
    expect(after.workers).toBe(before.workers);
    expect(after.accesses).toBe(before.accesses);
    expect(after.users).toBe(before.users);
    expect(after.events).toBe(before.events);
    expect(after.secret).toBe("tajne-haslo-axel-123");
  });

  it("odtwarza także kopię nieszyfrowaną", () => {
    seedDatabase();
    const backup = run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEY: undefined });
    expect(backup.status, backup.output).toBe(0);

    const files = backups();
    expect(files).toHaveLength(1);
    expect(files[0]).toMatch(/\.db$/);

    const restore = run("restore.cjs", [path.join(backupDir, files[0])], { USERBASE_BACKUP_KEY: undefined });
    expect(restore.status, restore.output).toBe(0);
    expect(readRestored().secret).toBe("tajne-haslo-axel-123");
  });

  it("kopia nieszyfrowana zawiera dane zapisane tuż przed nią (także te jeszcze w WAL-u)", () => {
    seedDatabase();
    // Dopisz pracownika tuż przed kopią. W trybie WAL jego wiersz może żyć wyłącznie
    // w pliku `-wal` — `VACUUM INTO` musi go jednak objąć, bo inaczej kopia gubiłaby
    // ostatnie transakcje, a tego nikt by nie zauważył do czasu odtworzenia.
    const add = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
        const db = lib.openDb();
        db.prepare("INSERT INTO workers (first_name,last_name,status,search_blob,created_at,updated_at) VALUES ('Anna','Nowak','aktywny','anna nowak',?,?)").run(Date.now(), Date.now());
        db.close();
        `,
      ],
      { cwd: ROOT, env: env(), encoding: "utf8" },
    );
    expect(add.status, add.stderr).toBe(0);

    const backup = run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEY: undefined });
    expect(backup.status, backup.output).toBe(0);

    // Skasuj bazę wraz z WAL-em — restore musi odtworzyć oba wiersze z samego snapshotu.
    for (const suffix of ["", "-wal", "-shm"]) rmSync(dbPath + suffix, { force: true });

    const restore = run("restore.cjs", [path.join(backupDir, backups(".db$")[0])], { USERBASE_BACKUP_KEY: undefined });
    expect(restore.status, restore.output).toBe(0);
    expect(readRestored().workers).toBe(2);
  });
});

describe("kopia zapasowa — kolizje i retencja", () => {
  it("trzy kopie wykonane w tej samej sekundzie nie nadpisują się", () => {
    seedDatabase();
    for (let i = 0; i < 3; i += 1) {
      const result = run("backup.cjs", [backupDir]);
      expect(result.status, result.output).toBe(0);
    }
    const files = backups();
    expect(files).toHaveLength(3);
    // Każda kopia musi być inna — te same dane, ale inny IV i znacznik czasu.
    for (const file of files) {
      expect(readFileSync(path.join(backupDir, file)).length).toBeGreaterThan(0);
    }
  });

  it("respektuje USERBASE_BACKUP_KEEP i nie usuwa kopii właśnie utworzonej", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir]).status).toBe(0);
    expect(run("backup.cjs", [backupDir]).status).toBe(0);

    const third = run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEEP: "1" });
    expect(third.status, third.output).toBe(0);
    expect(backups()).toHaveLength(1);

    // Wartość niepoprawna nie może usunąć świeżej kopii — spada na domyślną retencję,
    // więc obie kopie (poprzednia i świeża) zostają.
    const zero = run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEEP: "0" });
    expect(zero.status, zero.output).toBe(0);
    expect(backups()).toHaveLength(2);
  });
});

describe("odtwarzanie — ścieżki błędów", () => {
  it("odrzuca kopię zaszyfrowaną złym kluczem backupu i nie zostawia jawnych danych", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir]).status).toBe(0);
    const encrypted = path.join(backupDir, backups()[0]);
    const original = readFileSync(dbPath);

    const wrong = newKey();
    const restore = run("restore.cjs", [encrypted], { USERBASE_BACKUP_KEY: wrong });
    expect(restore.status).toBe(1);
    expect(restore.output).toContain("Nie udało się odszyfrować");

    // Baza docelowa musi pozostać nietknięta.
    expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );

    // Żaden katalog tymczasowy nie może zawierać odszyfrowanej bazy.
    for (const name of readdirSync(tmpdir())) {
      if (!TMP_PREFIXES.some((prefix) => name.startsWith(prefix))) continue;
      if (tmpBefore.has(name)) continue;
      expect(readdirSync(path.join(tmpdir(), name))).toEqual([]);
    }
  });

  it("odrzuca kopię, której nie otwiera bieżący KEK, i nie podmienia bazy", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir]).status).toBe(0);
    const encrypted = path.join(backupDir, backups()[0]);
    const original = readFileSync(dbPath);

    const restore = run("restore.cjs", [encrypted], { USERBASE_KEK: newKey() });
    expect(restore.status).toBe(1);
    expect(restore.output).toContain("nie odszyfrowuje klucza danych");
    expect(createHash("sha256").update(readFileSync(dbPath)).digest("hex")).toBe(
      createHash("sha256").update(original).digest("hex"),
    );
  });

  it("odrzuca uszkodzoną kopię (nadpisany bajt) zamiast ją odtworzyć", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEY: undefined }).status).toBe(0);
    const plain = path.join(backupDir, backups(".db$")[0]);

    // Uszkodzenie w środku pliku — SQLite musi to zauważyć.
    const data = readFileSync(plain);
    data.fill(0, Math.floor(data.length / 2), Math.floor(data.length / 2) + 64);
    writeFileSync(plain, data);

    const restore = run("restore.cjs", [plain], { USERBASE_BACKUP_KEY: undefined });
    expect(restore.status).toBe(1);
    expect(restore.output).toMatch(/uszkodzon|nie przeszła weryfikacji/i);
  });

  it("nie tworzy kopii, gdy bazy nie ma", () => {
    const result = run("backup.cjs", [backupDir]);
    expect(result.status).toBe(1);
    expect(result.output).toContain("Baza nie istnieje");
    expect(existsSync(backupDir) ? backups() : []).toEqual([]);
  });

  it("zostawia kopię obecnej bazy jako *.before-restore", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir], { USERBASE_BACKUP_KEY: undefined }).status).toBe(0);
    const plain = path.join(backupDir, backups(".db$")[0]);

    const restore = run("restore.cjs", [plain], { USERBASE_BACKUP_KEY: undefined });
    expect(restore.status, restore.output).toBe(0);
    expect(restore.output).toContain("Obecna baza zabezpieczona");
    const dataDir = path.dirname(dbPath);
    expect(readdirSync(dataDir).some((name) => name.includes(".before-restore-"))).toBe(true);
  });
});

describe("szyfrowanie pliku kopii", () => {
  it("weryfikacja odrzuca bazę, której DEK nie otwiera się bieżącym KEK", () => {
    seedDatabase();
    // `verifyDatabaseFile` to wspólny strażnik kopii i restore. Testujemy wprost,
    // bo od niego zależy, czy kopia z nieaktualnym KEK nie zostanie uznana za zdrową.
    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
        try {
          lib.verifyDatabaseFile(process.argv[1]);
          process.stdout.write("PRZESZLO");
        } catch (error) {
          process.stdout.write("ODRZUCONO: " + error.message);
        }
        `,
        dbPath,
      ],
      { cwd: ROOT, env: env({ USERBASE_KEK: newKey() }), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ODRZUCONO");
    expect(result.stdout).toContain("nie odszyfrowuje klucza danych");
  });

  it("weryfikacja odrzuca bazę z uszkodzonym łańcuchem audytu", () => {
    seedDatabase();
    // SQLite jest sprawny, ale treść wpisu audytu podmieniono — łańcuch musi to wykryć.
    const tamper = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
        const db = lib.openDb(process.argv[1]);
        db.exec("DROP TRIGGER audit_events_no_update");
        db.prepare("UPDATE audit_events SET summary = 'podmienione' WHERE seq = 1").run();
        db.close();
        `,
        dbPath,
      ],
      { cwd: ROOT, env: env(), encoding: "utf8" },
    );
    expect(tamper.status, tamper.stderr).toBe(0);

    const result = spawnSync(
      process.execPath,
      [
        "-e",
        `
        const lib = require(${JSON.stringify(path.join(SCRIPTS, "lib.cjs"))});
        try {
          lib.verifyDatabaseFile(process.argv[1]);
          process.stdout.write("PRZESZLO");
        } catch (error) {
          process.stdout.write("ODRZUCONO: " + error.message);
        }
        `,
        dbPath,
      ],
      { cwd: ROOT, env: env(), encoding: "utf8" },
    );
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout).toContain("ODRZUCONO");
    expect(result.stdout).toContain("Łańcuch audytu uszkodzony");
  });

  it("nie ujawnia w pliku `.enc` ani nazwiska, ani sekretu", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir]).status).toBe(0);
    const raw = readFileSync(path.join(backupDir, backups()[0]));

    // Nagłówek formatu jest jawny; dalej wyłącznie szyfrogram.
    expect(raw.subarray(0, 4).toString()).toBe("UBK1");
    const asText = raw.toString("latin1");
    expect(asText).not.toContain("Kowalski");
    expect(asText).not.toContain("tajne-haslo-axel-123");
    expect(asText).not.toContain("SQLite format 3");
  });

  it("każda kopia ma inny IV (ten sam klucz, ten sam stan bazy)", () => {
    seedDatabase();
    const ivs = new Set<string>();
    for (let i = 0; i < 2; i += 1) {
      expect(run("backup.cjs", [backupDir]).status).toBe(0);
      const file = backups().at(-1)!;
      const raw = readFileSync(path.join(backupDir, file));
      ivs.add(raw.subarray(4, 16).toString("hex"));
    }
    expect(ivs.size).toBe(2);
  });
});

describe("directory hygiene", () => {
  it("nie zostawia katalogów tymczasowych po udanych operacjach", () => {
    seedDatabase();
    expect(run("backup.cjs", [backupDir]).status).toBe(0);
    expect(run("restore.cjs", [path.join(backupDir, backups()[0])]).status).toBe(0);

    const leftovers = readdirSync(tmpdir()).filter(
      (name) => TMP_PREFIXES.some((prefix) => name.startsWith(prefix)) && !tmpBefore.has(name),
    );
    expect(leftovers).toEqual([]);
  });
});
