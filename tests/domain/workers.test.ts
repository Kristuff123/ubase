import { beforeEach, describe, expect, it } from "vitest";
import { createTestDb, type Db } from "@/db";
import {
  addAccess,
  archiveWorker,
  createWorker,
  findDuplicateWorker,
  getWorkerDetail,
  listWorkers,
  restoreWorker,
  revealSecret,
  revokeAccess,
  updateAccess,
  updateWorker,
  exportWorkerData,
} from "@/lib/domain/workers";
import { createOrgUnit, getCategoryBySlug } from "@/lib/domain/org";
import { accessFieldAad, decryptWithKey } from "@/lib/crypto/envelope";
import { getActiveKey } from "@/db/keys";
import { readHistory } from "@/lib/audit/log";

const actor = { userId: null, name: "tester", ip: "10.0.0.1" };

let db: Db;
let regionId: number;
let sklepId: number;
let zakladId: number;

beforeEach(() => {
  db = createTestDb();
  regionId = createOrgUnit(db, { type: "region", name: "Region Pomorski", actor }).id;
  sklepId = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", parentId: regionId, actor }).id;
  zakladId = createOrgUnit(db, { type: "zaklad", name: "PIEKARNIA", actor }).id;
});

function makeWorker(first = "Jan", last = "Kowalski", unitId: number | null = sklepId) {
  return createWorker(db, { firstName: first, lastName: last, orgUnitId: unitId, position: "Sprzedawca" }, actor);
}

describe("pracownicy", () => {
  it("tworzy pracownika z jednostką i wpisem audytowym", () => {
    const worker = makeWorker();
    expect(worker.id).toBeGreaterThan(0);
    expect(worker.status).toBe("aktywny");
    const audit = db.prepare("SELECT * FROM audit_events WHERE action = 'worker.created'").get() as {
      entity_id: number;
    };
    expect(audit.entity_id).toBe(worker.id);
  });

  it("wymaga imienia i nazwiska", () => {
    expect(() => createWorker(db, { firstName: "", lastName: "X" }, actor)).toThrow();
    expect(() => createWorker(db, { firstName: "X", lastName: "  " }, actor)).toThrow();
  });

  it("wykrywa duplikat tej samej osoby w tej samej jednostce", () => {
    makeWorker();
    expect(findDuplicateWorker(db, { firstName: "Jan", lastName: "Kowalski", orgUnitId: sklepId })).toBeDefined();
    expect(findDuplicateWorker(db, { firstName: "Jan", lastName: "Kowalski", orgUnitId: zakladId })).toBeUndefined();
  });

  it("zapisuje historię zmian pól przy edycji", () => {
    const worker = makeWorker();
    updateWorker(db, worker.id, { position: "Kierownik", phone: "600100200" }, actor);
    const history = readHistory(db, "worker", worker.id);
    const positionChange = history.find((h) => h.field_key === "Stanowisko");
    expect(positionChange?.old_value).toBe("Sprzedawca");
    expect(positionChange?.new_value).toBe("Kierownik");
    const phoneChange = history.find((h) => h.field_key === "Telefon");
    expect(phoneChange?.old_value).toBeNull();
    expect(phoneChange?.new_value).toBe("600100200");
  });

  it("nie zapisuje historii, gdy wartość się nie zmieniła", () => {
    const worker = makeWorker();
    updateWorker(db, worker.id, { position: "Sprzedawca" }, actor);
    expect(readHistory(db, "worker", worker.id)).toHaveLength(0);
  });

  it("archiwizuje i przywraca pracownika", () => {
    const worker = makeWorker();
    archiveWorker(db, worker.id, actor);
    expect(getWorkerDetail(db, worker.id)?.status).toBe("zarchiwizowany");
    expect(listWorkers(db, { status: "aktywny" }).total).toBe(0);
    expect(listWorkers(db, { status: "zarchiwizowany" }).total).toBe(1);
    expect(listWorkers(db, { status: "wszyscy" }).total).toBe(1);

    restoreWorker(db, worker.id, actor);
    expect(getWorkerDetail(db, worker.id)?.status).toBe("aktywny");
  });

  it("nie kasuje danych przy archiwizacji", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "jkowalski", password: "haslo1234" },
    }, actor);
    archiveWorker(db, worker.id, actor);
    const detail = getWorkerDetail(db, worker.id)!;
    expect(detail.accesses).toHaveLength(1);
  });
});

describe("dostępy", () => {
  it("dodaje dostęp Axela z zaszyfrowanym hasłem", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "jkowalski", password: "tajne1234" },
    }, actor);

    const row = db
      .prepare("SELECT * FROM access_fields WHERE access_id = ? AND field_key = 'password'")
      .get(accessId) as { value_text: string | null; value_enc: string | null };
    expect(row.value_text).toBeNull();
    expect(row.value_enc).toBeTruthy();
    expect(row.value_enc).not.toContain("tajne1234");

    const { dek } = getActiveKey(db);
    const decrypted = decryptWithKey(row.value_enc!, dek, accessFieldAad(worker.id, accessId, "password"));
    expect(decrypted).toBe("tajne1234");
  });

  it("login jest jawny (nie sekret)", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "jkowalski", password: "x" },
    }, actor);
    const row = db.prepare("SELECT * FROM access_fields WHERE access_id = ? AND field_key = 'login'").get(accessId) as {
      value_text: string;
      value_enc: string | null;
    };
    expect(row.value_text).toBe("jkowalski");
    expect(row.value_enc).toBeNull();
  });

  it("chip przyjmuje wiele poziomów dostępu", () => {
    const worker = makeWorker();
    const chip = getCategoryBySlug(db, "chip")!;
    addAccess(db, worker.id, {
      categoryId: chip.id,
      values: { number: "4471", level: ["piekarnia", "alarm", "biura"] },
    }, actor);
    const detail = getWorkerDetail(db, worker.id)!;
    const levelField = detail.accesses[0].fields.find((f) => f.key === "level")!;
    expect(levelField.values.sort()).toEqual(["alarm", "biura", "piekarnia"]);
  });

  it("odrzuca nieprawidłowy poziom chipa", () => {
    const worker = makeWorker();
    const chip = getCategoryBySlug(db, "chip")!;
    expect(() =>
      addAccess(db, worker.id, {
        categoryId: chip.id,
        values: { number: "1", level: ["piwnica"] },
      }, actor),
    ).toThrow(/Niedozwolona wartość/);
  });

  it("wymaga pola oznaczonego jako required", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    expect(() =>
      addAccess(db, worker.id, { categoryId: axel.id, values: { login: "x" } }, actor),
    ).toThrow(/wymagane/);
  });

  it("kategoria inne wymaga nazwy", () => {
    const worker = makeWorker();
    const inne = getCategoryBySlug(db, "inne")!;
    expect(() => addAccess(db, worker.id, { categoryId: inne.id, values: {} }, actor)).toThrow(/nazwę/);
    const id = addAccess(db, worker.id, { categoryId: inne.id, title: "Kasa fiskalna", values: {} }, actor);
    expect(id).toBeGreaterThan(0);
  });

  it("nie ujawnia sekretu w widoku szczegółów", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "jkowalski", password: "tajne1234" },
    }, actor);
    const detail = getWorkerDetail(db, worker.id)!;
    const passwordField = detail.accesses[0].fields.find((f) => f.key === "password")!;
    expect(passwordField.secret).toBe(true);
    expect(passwordField.hasValue).toBe(true);
    expect(passwordField.values.join()).not.toContain("tajne1234");
  });

  it("reveal zwraca odszyfrowaną wartość i loguje zdarzenie", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "jkowalski", password: "tajne1234" },
    }, actor);

    const revealed = revealSecret(db, { accessId, fieldKey: "password", actor });
    expect(revealed.values).toEqual(["tajne1234"]);

    const audit = db.prepare("SELECT * FROM audit_events WHERE action = 'secret.revealed'").get();
    expect(audit).toBeDefined();
  });

  it("reveal nie pozwala odszyfrować sekretu innym rekordem (AAD)", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "a", password: "haslo1" },
    }, actor);
    const otherWorker = makeWorker("Anna", "Nowak", zakladId);

    // Podmieniamy szyfrogram do innego dostępu — odszyfrowanie musi się nie udać.
    const row = db.prepare("SELECT value_enc FROM access_fields WHERE access_id = ? AND field_key='password'").get(accessId) as { value_enc: string };
    const otherAccess = addAccess(db, otherWorker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "b", password: "haslo2" },
    }, actor);
    db.prepare("UPDATE access_fields SET value_enc = ? WHERE access_id = ? AND field_key='password'").run(row.value_enc, otherAccess);
    expect(() => revealSecret(db, { accessId: otherAccess, fieldKey: "password", actor })).toThrow();
  });

  it("zmiana hasła zapisuje w historii znacznik zamiast wartości", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "a", password: "stare1234" },
    }, actor);
    updateAccess(db, accessId, {
      categoryId: axel.id,
      values: { login: "a", password: "nowe12345" },
    }, actor);

    const history = readHistory(db, "access", accessId);
    expect(history.length).toBeGreaterThan(0);
    const serialized = JSON.stringify(history);
    expect(serialized).not.toContain("stare1234");
    expect(serialized).not.toContain("nowe12345");
    expect(serialized).toContain("[zmieniono]");
  });

  it("wycofanie dostępu zachowuje rekord", () => {
    const worker = makeWorker();
    const axel = getCategoryBySlug(db, "axel")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: axel.id,
      values: { login: "a", password: "b" },
    }, actor);
    revokeAccess(db, accessId, actor);
    const detail = getWorkerDetail(db, worker.id)!;
    expect(detail.accesses[0].status).toBe("wycofany");
    expect(detail.accessCount).toBe(0);
  });

  it("liczy dostępy w liście pracowników", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "a", password: "b" },
    }, actor);
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "chip")!.id,
      values: { number: "1", level: ["alarm"] },
    }, actor);
    const list = listWorkers(db);
    expect(list.items[0].accessCount).toBe(2);
    expect(list.items[0].categories.map((c) => c.slug).sort()).toEqual(["axel", "chip"]);
  });
});

describe("wyszukiwarka", () => {
  it("znajduje po nazwisku bez polskich znaków", () => {
    makeWorker("Łukasz", "Żółć");
    expect(listWorkers(db, { q: "zolc" }).total).toBe(1);
    expect(listWorkers(db, { q: "żółć" }).total).toBe(1);
    expect(listWorkers(db, { q: "lukasz" }).total).toBe(1);
  });

  it("znajduje po numerze chipa", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "chip")!.id,
      values: { number: "99881", level: ["alarm"] },
    }, actor);
    expect(listWorkers(db, { q: "99881" }).total).toBe(1);
  });

  it("znajduje po lognie Axela", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "jkowalski-axel", password: "x" },
    }, actor);
    expect(listWorkers(db, { q: "jkowalski-axel" }).total).toBe(1);
  });

  it("filtruje po kategorii dostępu", () => {
    const w1 = makeWorker();
    const w2 = makeWorker("Anna", "Nowak", zakladId);
    addAccess(db, w1.id, {
      categoryId: getCategoryBySlug(db, "monitoring")!.id,
      values: { scope: "wszystkie", login: "mon" },
    }, actor);
    expect(listWorkers(db, { categorySlug: "monitoring" }).total).toBe(1);
    expect(listWorkers(db, {}).total).toBe(2);
    expect(w2.id).not.toBe(w1.id);
  });

  it("nie zwraca zarchiwizowanych domyślnie", () => {
    const worker = makeWorker();
    archiveWorker(db, worker.id, actor);
    expect(listWorkers(db).total).toBe(0);
    expect(listWorkers(db, { status: "wszyscy" }).total).toBe(1);
  });
});

describe("eksport RODO", () => {
  it("domyślnie pomija sekrety", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "a", password: "sekret123" },
    }, actor);
    const data = exportWorkerData(db, worker.id, { includeSecrets: false, actor });
    const json = JSON.stringify(data);
    expect(json).not.toContain("sekret123");
    expect(json).toContain("[pominięto]");
  });

  it("z sekretami wymaga jawnej flagi i loguje", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "a", password: "sekret123" },
    }, actor);
    exportWorkerData(db, worker.id, { includeSecrets: true, actor });
    const audit = db.prepare("SELECT * FROM audit_events WHERE action='worker.exported'").get() as {
      summary: string;
    };
    expect(audit.summary).toContain("z sekretami");
  });
});

describe("szyfrowanie w bazie", () => {
  it("wartość sekretna nie występuje w pliku bazy jako plaintext", () => {
    const worker = makeWorker();
    addAccess(db, worker.id, {
      categoryId: getCategoryBySlug(db, "axel")!.id,
      values: { login: "a", password: "BardzoTajneHaslo" },
    }, actor);
    // Sprawdzamy zawartość wszystkich stron bazy.
    const rows = db
      .prepare("SELECT value_text, value_enc FROM access_fields")
      .all() as { value_text: string | null; value_enc: string | null }[];
    for (const row of rows) {
      expect(row.value_text ?? "").not.toContain("BardzoTajneHaslo");
    }
  });

  it("round-trip wielu sekretów w jednym dostępie", () => {
    const worker = makeWorker();
    const poczta = getCategoryBySlug(db, "poczta")!;
    const accessId = addAccess(db, worker.id, {
      categoryId: poczta.id,
      values: {
        account_type: "firmowe",
        address: "biuro@firma.pl",
        password: "hasloPoczty1",
        recovery: "kod1\nkod2\nkod3",
      },
    }, actor);
    expect(revealSecret(db, { accessId, fieldKey: "password", actor }).values[0]).toBe("hasloPoczty1");
    expect(revealSecret(db, { accessId, fieldKey: "recovery", actor }).values[0]).toBe("kod1\nkod2\nkod3");
  });
});
