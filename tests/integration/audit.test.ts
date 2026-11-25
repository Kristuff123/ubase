/**
 * Audyt — integralność łańcucha, append-only, wykrywanie manipulacji, eksport.
 *
 * Te testy odpowiadają na pytanie audytora: „skąd wiem, że log nie został zmieniony?”.
 * Każda manipulacja musi być wykryta i wskazać dokładne miejsce uszkodzenia.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { appendAudit, readAuditRange, readHistory, verifyAuditChain } from "@/lib/audit/log";
import { createWorker, updateWorker } from "@/lib/domain/workers";
import { actAs, getRequest, makeDb, readJsonBody, seedUser, type TestUser } from "./harness";

import * as auditRoute from "@/app/api/audit/route";
import * as auditVerifyRoute from "@/app/api/audit/verify/route";
import * as auditExportRoute from "@/app/api/audit/export/route";

const actor = { userId: null, name: "tester", ip: "10.0.0.1" };

let db: Db;
let admin: TestUser;
let audytor: TestUser;

beforeEach(async () => {
  db = makeDb();
  admin = await seedUser(db, { username: "admin1", role: "admin", displayName: "Ala Admin" });
  audytor = await seedUser(db, { username: "audyt1", role: "audytor" });
});

function seedEvents(count = 5): void {
  for (let i = 0; i < count; i += 1) {
    appendAudit(db, { action: "worker.created", actor, summary: `Zdarzenie ${i}` });
  }
}

/**
 * Symuluje atak bezpośrednio na plik bazy: usuwa triggery append-only, wykonuje
 * operację i przywraca triggery. Tak wygląda realna manipulacja przez kogoś
 * z dostępem do serwera — i dokładnie ją ma wykryć weryfikacja łańcucha.
 */
function tamper(statements: string[]): void {
  const triggers = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = 'audit_events'")
    .all() as { name: string; sql: string }[];
  for (const trigger of triggers) db.exec(`DROP TRIGGER ${trigger.name}`);
  for (const statement of statements) db.prepare(statement).run();
  for (const trigger of triggers) db.exec(trigger.sql);
}

describe("integralność łańcucha", () => {
  it("pusty log jest poprawny", () => {
    const result = verifyAuditChain(db);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(0);
  });

  it("kolejne wpisy tworzą spójny łańcuch", () => {
    seedEvents(5);
    const result = verifyAuditChain(db);
    expect(result.valid).toBe(true);
    expect(result.checked).toBe(5);
  });

  it("każdy wpis wskazuje hash poprzedniego", () => {
    seedEvents(3);
    const rows = db.prepare("SELECT seq, prev_hash, entry_hash FROM audit_events ORDER BY seq").all() as {
      seq: number;
      prev_hash: string;
      entry_hash: string;
    }[];
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].entry_hash);
    }
  });

  it("wykrywa zmianę treści wpisu", () => {
    seedEvents(4);
    // Próba cichej podmiany treści (trigger append-only trzeba obejść).
    tamper(["UPDATE audit_events SET summary = 'Podmienione' WHERE seq = 2"]);
    const result = verifyAuditChain(db);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(2);
  });

  it("wykrywa usunięcie wpisu ze środka", () => {
    seedEvents(5);
    tamper(["DELETE FROM audit_events WHERE seq = 3"]);
    const result = verifyAuditChain(db);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(4); // następny wpis ma niepasujący prev_hash
  });

  it("wykrywa zmianę autora wpisu", () => {
    seedEvents(3);
    tamper(["UPDATE audit_events SET actor_name = 'Ktoś inny' WHERE seq = 2"]);
    expect(verifyAuditChain(db).valid).toBe(false);
  });

  it("wykrywa zmianę szczegółów zdarzenia", () => {
    appendAudit(db, { action: "worker.created", actor, summary: "Test", details: { kwota: 100 } });
    tamper([`UPDATE audit_events SET details_json = '{"kwota":9999}' WHERE seq = 1`]);
    expect(verifyAuditChain(db).valid).toBe(false);
  });

  it("wykrywa dopisanie wpisu z błędnym hashem", () => {
    seedEvents(2);
    tamper([
      `INSERT INTO audit_events (seq, at, actor_name, action, summary, prev_hash, entry_hash)
       VALUES (3, ${Date.now()}, 'tester', 'worker.created', 'Fałszywy wpis', 'byle-co', 'tez-byle-co')`,
    ]);
    const result = verifyAuditChain(db);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(3);
  });
});

describe("append-only na poziomie bazy", () => {
  it("zwykły UPDATE jest blokowany przez trigger", () => {
    seedEvents(1);
    expect(() => db.prepare("UPDATE audit_events SET summary = 'X' WHERE seq = 1").run()).toThrow();
  });

  it("zwykły DELETE jest blokowany przez trigger", () => {
    seedEvents(1);
    expect(() => db.prepare("DELETE FROM audit_events WHERE seq = 1").run()).toThrow();
  });
});

describe("historia zmian pól", () => {
  it("zapisuje starą i nową wartość", () => {
    const worker = createWorker(db, { firstName: "Jan", lastName: "Kowalski", position: "Sprzedawca" }, actor);
    updateWorker(db, worker.id, { position: "Kierownik" }, actor);
    const history = readHistory(db, "worker", worker.id);
    const change = history.find((h) => h.field_key === "Stanowisko")!;
    expect(change.old_value).toBe("Sprzedawca");
    expect(change.new_value).toBe("Kierownik");
  });

  it("pusta historia dla nowego rekordu", () => {
    const worker = createWorker(db, { firstName: "Jan", lastName: "Kowalski" }, actor);
    expect(readHistory(db, "worker", worker.id)).toHaveLength(0);
  });
});

describe("filtry i eksport", () => {
  it("filtruje po akcji", () => {
    appendAudit(db, { action: "worker.created", actor, summary: "A" });
    appendAudit(db, { action: "secret.revealed", actor, summary: "B" });
    appendAudit(db, { action: "worker.created", actor, summary: "C" });
    const onlyCreated = readAuditRange(db, { action: "worker.created" });
    expect(onlyCreated).toHaveLength(2);
  });

  it("filtruje po zakresie czasu", () => {
    appendAudit(db, { action: "worker.created", actor, summary: "Stare" });
    tamper([`UPDATE audit_events SET at = ${Date.now() - 86_400_000} WHERE seq = 1`]);
    appendAudit(db, { action: "worker.created", actor, summary: "Nowe" });

    const recent = readAuditRange(db, { from: Date.now() - 3600_000 });
    expect(recent).toHaveLength(1);
    expect(recent[0].summary).toBe("Nowe");
  });

  it("respektuje limit i offset", () => {
    seedEvents(10);
    const page = readAuditRange(db, { limit: 3, offset: 2 });
    expect(page).toHaveLength(3);
  });

  it("API zwraca zdarzenia z hashami", async () => {
    actAs(db, audytor);
    seedEvents(2);
    const res = await auditRoute.GET(getRequest("http://x/api/audit"));
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ events: { entryHash: string; prevHash: string }[] }>(res);
    expect(body.events.length).toBeGreaterThanOrEqual(2);
    expect(body.events[0].entryHash).toHaveLength(64);
  });

  it("API eksportuje CSV z nagłówkiem i bez sekretów", async () => {
    actAs(db, audytor);
    seedEvents(2);
    const res = await auditExportRoute.GET(getRequest("http://x/api/audit/export"));
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("text/csv");
    const csv = await res.text();
    expect(csv.split("\n")[0]).toContain("seq");
    expect(csv).toContain("Zdarzenie 0");
  });

  it("weryfikacja przez API dopisuje wpis audit.verified", async () => {
    actAs(db, admin);
    seedEvents(2);
    const res = await auditVerifyRoute.GET();
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ valid: boolean; checked: number }>(res);
    expect(body.valid).toBe(true);
    const verified = db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE action='audit.verified'").get() as {
      c: number;
    };
    expect(verified.c).toBe(1);
  });

  it("weryfikacja wykrywa manipulację przez API", async () => {
    actAs(db, admin);
    seedEvents(3);
    tamper(["UPDATE audit_events SET summary = 'X' WHERE seq = 2"]);
    const res = await auditVerifyRoute.GET();
    const body = await readJsonBody<{ valid: boolean; brokenAt: number }>(res);
    expect(body.valid).toBe(false);
    expect(body.brokenAt).toBe(2);
  });
});

describe("sekrety w audycie", () => {
  it("wpis o zmianie hasła nie zawiera wartości", async () => {
    const mod = await import("@/lib/domain/workers");
    const org = await import("@/lib/domain/org");
    const worker = createWorker(db, { firstName: "Jan", lastName: "Kowalski" }, actor);
    const accessId = mod.addAccess(
      db,
      worker.id,
      { categoryId: org.getCategoryBySlug(db, "axel")!.id, values: { login: "a", password: "SekretneHaslo1" } },
      actor,
    );
    mod.updateAccess(
      db,
      accessId,
      { categoryId: org.getCategoryBySlug(db, "axel")!.id, values: { login: "a", password: "NoweHaslo2" } },
      actor,
    );
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    expect(dump).not.toContain("SekretneHaslo1");
    expect(dump).not.toContain("NoweHaslo2");
    const historyDump = JSON.stringify(db.prepare("SELECT * FROM record_history").all());
    expect(historyDump).not.toContain("SekretneHaslo1");
    expect(historyDump).not.toContain("NoweHaslo2");
  });
});
