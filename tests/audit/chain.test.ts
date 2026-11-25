import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import { appendAudit, readAuditRange, recordFieldChange, readHistory, verifyAuditChain } from "@/lib/audit/log";
import { computeEntryHash, GENESIS_HASH, verifyChain, type StoredAuditRow } from "@/lib/audit/chain";

const actor = { userId: null, name: "tester", ip: "10.0.0.1" };

let db: Db;

beforeEach(() => {
  db = createTestDb();
});

describe("łańcuch audytu", () => {
  it("pierwszy wpis wskazuje na genesis", () => {
    appendAudit(db, { action: "worker.created", actor, summary: "pierwszy" });
    const row = db.prepare("SELECT * FROM audit_events ORDER BY seq").get() as StoredAuditRow;
    expect(row.prev_hash).toBe(GENESIS_HASH);
    expect(row.entry_hash).toHaveLength(64);
  });

  it("każdy wpis łączy się z poprzednim", () => {
    for (let i = 0; i < 5; i += 1) {
      appendAudit(db, { action: "worker.created", actor, summary: `wpis ${i}` });
    }
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as StoredAuditRow[];
    for (let i = 1; i < rows.length; i += 1) {
      expect(rows[i].prev_hash).toBe(rows[i - 1].entry_hash);
    }
    expect(verifyAuditChain(db).valid).toBe(true);
  });

  it("wykrywa podmianę treści wpisu", () => {
    for (let i = 0; i < 3; i += 1) {
      appendAudit(db, { action: "worker.created", actor, summary: `wpis ${i}` });
    }
    // Obejście triggera: symulujemy atak bezpośrednio na kopii danych.
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as StoredAuditRow[];
    rows[1].summary = "podmienione";
    const result = verifyChain(rows);
    expect(result.valid).toBe(false);
    expect(result.brokenAt).toBe(rows[1].seq);
  });

  it("wykrywa usunięcie wpisu w środku", () => {
    for (let i = 0; i < 4; i += 1) {
      appendAudit(db, { action: "worker.created", actor, summary: `wpis ${i}` });
    }
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as StoredAuditRow[];
    const withoutMiddle = [rows[0], rows[2], rows[3]];
    const result = verifyChain(withoutMiddle);
    expect(result.valid).toBe(false);
  });

  it("wykrywa zmianę szczegółów wpisu", () => {
    appendAudit(db, { action: "secret.revealed", actor, summary: "podgląd", details: { accessId: 1 } });
    const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq").all() as StoredAuditRow[];
    rows[0].details_json = JSON.stringify({ accessId: 999 });
    expect(verifyChain(rows).valid).toBe(false);
  });

  it("kanoniczny JSON jest niewrażliwy na kolejność kluczy", () => {
    const base = {
      seq: 1,
      at: 100,
      actorUserId: 1,
      actorName: "a",
      actorIp: null,
      action: "x",
      entityType: "worker",
      entityId: 1,
      summary: "s",
      details: { a: 1, b: 2 },
    };
    const reordered = { ...base, details: { b: 2, a: 1 } };
    expect(computeEntryHash("prev", base)).toBe(computeEntryHash("prev", reordered));
  });

  it("różne poprzednie hashe dają różne wpisy", () => {
    const payload = {
      seq: 1,
      at: 100,
      actorUserId: null,
      actorName: null,
      actorIp: null,
      action: "x",
      entityType: null,
      entityId: null,
      summary: "s",
      details: null,
    };
    expect(computeEntryHash("a", payload)).not.toBe(computeEntryHash("b", payload));
  });
});

describe("filtrowanie logu", () => {
  it("filtruje po akcji i aktorze", () => {
    appendAudit(db, { action: "worker.created", actor, summary: "1" });
    appendAudit(db, { action: "secret.revealed", actor, summary: "2" });
    appendAudit(db, { action: "worker.created", actor, summary: "3" });

    expect(readAuditRange(db, { action: "worker.created" })).toHaveLength(2);
    expect(readAuditRange(db, { action: "secret.revealed" })).toHaveLength(1);
    expect(readAuditRange(db, {})).toHaveLength(3);
  });

  it("ogranicza liczbę wyników i respektuje offset", () => {
    for (let i = 0; i < 10; i += 1) appendAudit(db, { action: "worker.created", actor, summary: `${i}` });
    expect(readAuditRange(db, { limit: 3 })).toHaveLength(3);
    expect(readAuditRange(db, { limit: 3, offset: 8 })).toHaveLength(2);
  });
});

describe("historia rekordu", () => {
  it("zapisuje zmianę pola z autorem", () => {
    recordFieldChange(db, {
      entityType: "worker",
      entityId: 1,
      fieldKey: "Stanowisko",
      oldValue: "Sprzedawca",
      newValue: "Kierownik",
      actorUserId: null,
    });
    const history = readHistory(db, "worker", 1);
    expect(history).toHaveLength(1);
    expect(history[0].old_value).toBe("Sprzedawca");
    expect(history[0].new_value).toBe("Kierownik");
  });

  it("nie miesza historii różnych encji", () => {
    recordFieldChange(db, { entityType: "worker", entityId: 1, fieldKey: "A", oldValue: "x", newValue: "y", actorUserId: null });
    recordFieldChange(db, { entityType: "access", entityId: 1, fieldKey: "A", oldValue: "x", newValue: "y", actorUserId: null });
    expect(readHistory(db, "worker", 1)).toHaveLength(1);
    expect(readHistory(db, "access", 1)).toHaveLength(1);
  });
});
