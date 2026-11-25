import { describe, expect, it } from "vitest";
import { createTestDb } from "@/db";
import { createOrgUnit, listCategories, listOrgUnits, parseSchema } from "@/lib/domain/org";

const actor = { userId: null, name: "test", ip: null };

describe("migracje i dane startowe", () => {
  it("tworzy schemat i ustawia wersję migracji", () => {
    const db = createTestDb();
    const version = db.pragma("user_version", { simple: true });
    expect(Number(version)).toBeGreaterThanOrEqual(2);
    const tables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name")
      .all()
      .map((r) => (r as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "app_users",
        "sessions",
        "access_categories",
        "workers",
        "accesses",
        "access_fields",
        "audit_events",
        "record_history",
        "org_units",
        "crypto_keys",
      ]),
    );
  });

  it("seeduje kategorie systemowe z poprawnym schematem", () => {
    const db = createTestDb();
    const categories = listCategories(db);
    const slugs = categories.map((c) => c.slug);
    expect(slugs).toEqual(
      expect.arrayContaining(["chip", "axel", "bclient", "remote", "monitoring", "poczta", "google", "inne"]),
    );

    const chip = categories.find((c) => c.slug === "chip")!;
    const schema = parseSchema(chip);
    const numberFormat = schema.find((f) => f.key === "number_format")!;
    expect(numberFormat.type).toBe("select");
    expect(numberFormat.options).toEqual(["dziesiętnie", "szesnastkowo"]);
    expect(numberFormat.defaultValue).toBe("dziesiętnie");

    const level = schema.find((f) => f.key === "level")!;
    expect(level.type).toBe("multiselect");
    expect(level.options).toEqual(["piekarnia", "cukiernia", "biura", "pierogarnia", "alarm"]);

    const axel = categories.find((c) => c.slug === "axel")!;
    const password = parseSchema(axel).find((f) => f.key === "password")!;
    expect(password.secret).toBe(true);
  });

  it("blokuje UPDATE i DELETE w logu audytowym", () => {
    const db = createTestDb();
    db.prepare(
      `INSERT INTO audit_events (seq, at, action, summary, prev_hash, entry_hash)
       VALUES (1, 1, 'test', 'wpis', 'prev', 'hash')`,
    ).run();
    expect(() => db.prepare("UPDATE audit_events SET summary = 'zmiana' WHERE seq = 1").run()).toThrow();
    expect(() => db.prepare("DELETE FROM audit_events WHERE seq = 1").run()).toThrow();
  });

  it("wymusza unikalność jednostek w obrębie typu", () => {
    const db = createTestDb();
    createOrgUnit(db, { type: "region", name: "Region Pomorski", actor });
    expect(() => createOrgUnit(db, { type: "region", name: "Region Pomorski", actor })).toThrow();
    // Ta sama nazwa, inny typ — dozwolone.
    expect(() => createOrgUnit(db, { type: "zaklad", name: "Region Pomorski", actor })).not.toThrow();
  });

  it("sklep musi mieć rodzica typu region", () => {
    const db = createTestDb();
    const zaklad = createOrgUnit(db, { type: "zaklad", name: "PIEKARNIA", actor });
    expect(() => createOrgUnit(db, { type: "sklep", name: "Sklep X", parentId: zaklad.id, actor })).toThrow();
    const region = createOrgUnit(db, { type: "region", name: "Region Pomorski", actor });
    const sklep = createOrgUnit(db, { type: "sklep", name: "Sklep X", parentId: region.id, actor });
    expect(sklep.parent_id).toBe(region.id);
  });

  it("listuje jednostki posortowane po typie i nazwie", () => {
    const db = createTestDb();
    createOrgUnit(db, { type: "zaklad", name: "PIEROGARNIA", actor });
    createOrgUnit(db, { type: "zaklad", name: "BISTRO", actor });
    createOrgUnit(db, { type: "region", name: "Region Pomorski", actor });
    const units = listOrgUnits(db);
    expect(units.map((u) => u.name)).toEqual(["Region Pomorski", "BISTRO", "PIEROGARNIA"]);
  });
});
