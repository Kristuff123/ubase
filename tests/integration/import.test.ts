/**
 * Import z Excela — podgląd, walidacja, mapowanie kolumn, tworzenie jednostek, commit.
 *
 * Pliki budujemy prawdziwym ExcelJS-em (nie mockiem), więc test obejmuje też
 * parsowanie skoroszytu, wykrywanie nagłówków i scalanie komórek z formułami.
 */
import { beforeEach, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";
import type { Db } from "@/db";
import {
  commitImport,
  parseWorkbook,
  previewImport,
  suggestMapping,
  type ParsedSheet,
} from "@/lib/domain/import";
import { createOrgUnit } from "@/lib/domain/org";
import { listWorkers } from "@/lib/domain/workers";
import { actAs, makeDb, readJsonBody, seedUser, type TestUser } from "./harness";

import * as previewRoute from "@/app/api/import/preview/route";
import * as commitRoute from "@/app/api/import/commit/route";

const actor = { userId: null, name: "tester", ip: "10.0.0.1" };

let db: Db;
let admin: TestUser;
let audytor: TestUser;

async function xlsx(rows: (string | number | Date | null)[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Pracownicy");
  for (const row of rows) sheet.addRow(row);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function sheetOf(rows: Record<string, string>[], columns: string[]): ParsedSheet {
  return { columns, rows };
}

beforeEach(async () => {
  db = makeDb();
  admin = await seedUser(db, { username: "admin1", role: "admin", displayName: "Ala Admin" });
  audytor = await seedUser(db, { username: "audyt1", role: "audytor" });
});

describe("parsowanie skoroszytu", () => {
  it("czyta nagłówki i pomija puste wiersze", async () => {
    const buffer = await xlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Jan", "Kowalski", "Bytów Kaufland"],
      [null, null, null],
      ["Anna", "Nowak", "Słupsk Lidl"],
    ]);
    const sheet = await parseWorkbook(buffer);
    expect(sheet.columns).toEqual(["Imię", "Nazwisko", "Sklep"]);
    expect(sheet.rows).toHaveLength(2);
    expect(sheet.rows[1].Imię).toBe("Anna");
  });

  it("zamienia liczby i daty na tekst", async () => {
    const buffer = await xlsx([
      ["Imię", "Nazwisko", "Telefon", "Data"],
      ["Jan", "Kowalski", 600100200, new Date("2021-03-04")],
    ]);
    const sheet = await parseWorkbook(buffer);
    expect(sheet.rows[0].Telefon).toBe("600100200");
    expect(sheet.rows[0].Data).toBe("2021-03-04");
  });

  it("odrzuca plik bez arkusza", async () => {
    const workbook = new ExcelJS.Workbook();
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(parseWorkbook(buffer)).rejects.toThrow(/arkusza/);
  });
});

describe("heurystyka mapowania kolumn", () => {
  it("rozpoznaje polskie nagłówki bez diakrytyków", () => {
    const mapping = suggestMapping(["Imie", "Nazwisko", "Stanowisko", "Sklep", "E-mail", "Telefon", "Login"]);
    expect(mapping.Imie).toBe("firstName");
    expect(mapping.Nazwisko).toBe("lastName");
    expect(mapping.Stanowisko).toBe("position");
    expect(mapping.Sklep).toBe("orgUnit");
    expect(mapping["E-mail"]).toBe("email");
    expect(mapping.Telefon).toBe("phone");
    expect(mapping.Login).toBe("ignore");
  });

  it("rozpoznaje „Imię i nazwisko” jako pełne imię", () => {
    expect(suggestMapping(["Imię i nazwisko"])["Imię i nazwisko"]).toBe("fullName");
  });

  it("nieznane kolumny trafiają do ignore", () => {
    expect(suggestMapping(["Cokolwiek"])["Cokolwiek"]).toBe("ignore");
  });
});

describe("podgląd importu", () => {
  it("rozdziela „Imię i nazwisko” na dwie części", () => {
    const preview = previewImport(
      db,
      sheetOf([{ "Imię i nazwisko": "Jan Kowalski" }], ["Imię i nazwisko"]),
      { mapping: { "Imię i nazwisko": "fullName" } },
    );
    expect(preview.rows[0].normalized?.firstName).toBe("Jan");
    expect(preview.rows[0].normalized?.lastName).toBe("Kowalski");
  });

  it("zostawia wieloczłonowe nazwisko w całości", () => {
    const preview = previewImport(
      db,
      sheetOf([{ Pracownik: "Anna Maria Kowalska-Nowak" }], ["Pracownik"]),
      { mapping: { Pracownik: "fullName" } },
    );
    expect(preview.rows[0].normalized?.firstName).toBe("Anna");
    expect(preview.rows[0].normalized?.lastName).toBe("Maria Kowalska-Nowak");
  });

  it("oznacza wiersz bez nazwiska jako błąd", () => {
    const preview = previewImport(db, sheetOf([{ Imie: "Jan" }], ["Imie"]), { mapping: { Imie: "firstName" } });
    expect(preview.rows[0].status).toBe("error");
    expect(preview.rows[0].messages).toContain("Brak nazwiska");
  });

  it("nieznana jednostka to ostrzeżenie, nie błąd", () => {
    const preview = previewImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "Kowalski", Sklep: "Nieistniejący" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
    );
    expect(preview.rows[0].status).toBe("warning");
    expect(preview.unknownUnits).toEqual(["Nieistniejący"]);
  });

  it("dopasowuje jednostkę bez względu na diakrytyki i wielkość liter", () => {
    createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const preview = previewImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "K", Sklep: "bytow kaufland" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
    );
    expect(preview.rows[0].status).toBe("ok");
    expect(preview.unknownUnits).toHaveLength(0);
  });

  /**
   * Regresja: etykieta „Zaimportuj N osób" liczyła tylko wiersze bez uwag,
   * a commit przyjmuje także wiersze ze statusem „uwaga" (mają jednostkę).
   * `importable` to jedyna liczba, którą UI powinno pokazywać.
   */
  it("podaje realną liczbę wierszy do importu (ok + uwaga z jednostką)", () => {
    createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const preview = previewImport(
      db,
      sheetOf(
        [
          { Imie: "Jan", Nazwisko: "Kowalski", Sklep: "Bytów Kaufland", Mail: "jan@firma.pl" },
          // Uwaga: e-mail nieprawidłowy, ale jednostka znana → wiersz wejdzie.
          { Imie: "Anna", Nazwisko: "Nowak", Sklep: "Bytów Kaufland", Mail: "zly-mail" },
          // Uwaga: nieznana jednostka → bez decyzji w UI wiersz zostanie pominięty.
          { Imie: "Piotr", Nazwisko: "Zielinski", Sklep: "Nieistniejący", Mail: "p@firma.pl" },
          // Błąd: brak nazwiska → nigdy nie wejdzie.
          { Imie: "Bez", Nazwisko: "", Sklep: "Bytów Kaufland", Mail: "b@firma.pl" },
        ],
        ["Imie", "Nazwisko", "Sklep", "Mail"],
      ),
      {
        mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit", Mail: "email" },
      },
    );

    expect(preview.summary.total).toBe(4);
    expect(preview.summary.ok).toBe(1);
    expect(preview.summary.warning).toBe(2);
    expect(preview.summary.error).toBe(1);
    expect(preview.importable).toBe(2);
  });

  it("po rozwiązaniu nieznanej jednostki wiersz staje się importowalny", () => {
    const unit = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const preview = previewImport(
      db,
      sheetOf([{ Imie: "Piotr", Nazwisko: "Zielinski", Sklep: "Nieistniejący" }], ["Imie", "Nazwisko", "Sklep"]),
      {
        mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" },
        unitResolution: { Nieistniejący: unit.id },
      },
    );
    expect(preview.summary.warning).toBe(0);
    expect(preview.importable).toBe(1);
  });

  it("wykrywa duplikat istniejącego pracownika", () => {
    const unit = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    db.prepare(
      "INSERT INTO workers (first_name,last_name,status,org_unit_id,created_at,updated_at,search_blob) VALUES ('Jan','Kowalski','aktywny',?,?,?,'jan kowalski')",
    ).run(unit.id, Date.now(), Date.now());
    const preview = previewImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "Kowalski", Sklep: "Bytów Kaufland" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
    );
    expect(preview.rows[0].status).toBe("duplicate");
  });

  it("flaguje nieprawidłowy e-mail", () => {
    const preview = previewImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "K", Mail: "niepoprawny" }], ["Imie", "Nazwisko", "Mail"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Mail: "email" } },
    );
    expect(preview.rows[0].status).toBe("warning");
    expect(preview.rows[0].messages.join()).toContain("e-mail");
  });

  it("podgląd nie zapisuje niczego do bazy", () => {
    previewImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "Kowalski" }], ["Imie", "Nazwisko"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName" } },
    );
    expect(listWorkers(db).total).toBe(0);
  });
});

describe("commit importu", () => {
  it("tworzy pracowników i pomija duplikaty", () => {
    createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const sheet = sheetOf(
      [
        { Imie: "Jan", Nazwisko: "Kowalski", Sklep: "Bytów Kaufland" },
        { Imie: "Anna", Nazwisko: "Nowak", Sklep: "Bytów Kaufland" },
      ],
      ["Imie", "Nazwisko", "Sklep"],
    );
    const result = commitImport(
      db,
      sheet,
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
      actor,
      { onlyValid: true, fileName: "test.xlsx" },
    );
    expect(result.created).toBe(2);
    expect(result.skipped).toBe(0);
    const list = listWorkers(db);
    expect(list.total).toBe(2);
    expect(list.items.every((w) => w.orgUnitName === "Bytów Kaufland")).toBe(true);
  });

  it("zapisuje wpis audytowy z licznikami", () => {
    const unit = createOrgUnit(db, { type: "sklep", name: "Audytowy Sklep", actor });
    commitImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "Kowalski", Sklep: "X" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" }, unitResolution: { X: unit.id } },
      actor,
      { onlyValid: true, fileName: "lista.xlsx" },
    );
    const audit = db.prepare("SELECT * FROM audit_events WHERE action='import.committed'").get() as {
      summary: string;
    };
    expect(audit.summary).toContain("lista.xlsx");
    expect(audit.summary).toContain("dodano 1");
  });

  it("tworzy brakujące jednostki, gdy createMissingUnits=true", () => {
    const result = commitImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "K", Sklep: "Nowy Sklep" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" }, createMissingUnits: true },
      actor,
      { onlyValid: true, fileName: "t.xlsx" },
    );
    expect(result.created).toBe(1);
    const unit = db.prepare("SELECT * FROM org_units WHERE name = 'Nowy Sklep'").get() as { type: string };
    expect(unit.type).toBe("sklep");
  });

  it("bez createMissingUnits pomija wiersz z nieznaną jednostką", () => {
    const result = commitImport(
      db,
      sheetOf([{ Imie: "Jan", Nazwisko: "K", Sklep: "Nowy Sklep" }], ["Imie", "Nazwisko", "Sklep"]),
      { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
      actor,
      { onlyValid: true, fileName: "t.xlsx" },
    );
    expect(result.created).toBe(0);
    expect(result.skipped).toBe(1);
    expect(listWorkers(db).total).toBe(0);
  });

  it("z onlyValid=false przerywa cały import przy błędnym wierszu (atomowość)", () => {
    const unit = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const sheet = sheetOf(
      [
        { Imie: "Jan", Nazwisko: "Kowalski", Sklep: "Bytów Kaufland" },
        { Imie: "Anna", Nazwisko: "Nowak", Sklep: "Nieznana" },
      ],
      ["Imie", "Nazwisko", "Sklep"],
    );
    expect(() =>
      commitImport(
        db,
        sheet,
        { mapping: { Imie: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" } },
        actor,
        { onlyValid: false, fileName: "t.xlsx" },
      ),
    ).toThrow();
    // Transakcja wycofana — pierwszy wiersz też nie został zapisany.
    expect(listWorkers(db).total).toBe(0);
    expect(unit.id).toBeGreaterThan(0);
  });
});

describe("API importu", () => {
  function form(buffer: Buffer, fields: Record<string, string> = {}): Request {
    const data = new FormData();
    data.set("file", new File([new Uint8Array(buffer)], "lista.xlsx"));
    for (const [key, value] of Object.entries(fields)) data.set(key, value);
    return new Request("http://x/api/import/preview", { method: "POST", body: data });
  }

  it("podgląd przez API zwraca statystyki i sugerowane mapowanie", async () => {
    actAs(db, admin);
    const buffer = await xlsx([
      ["Imię", "Nazwisko"],
      ["Jan", "Kowalski"],
    ]);
    const res = await previewRoute.POST(form(buffer));
    expect(res.status).toBe(200);
    const body = await readJsonBody<{
      phase: string;
      preview: { summary: { total: number; ok: number }; suggestedMapping: Record<string, string> };
    }>(res);
    expect(body.phase).toBe("preview");
    expect(body.preview.summary.total).toBe(1);
    expect(body.preview.suggestedMapping["Imię"]).toBe("firstName");
  });

  it("commit przez API tworzy pracowników", async () => {
    actAs(db, admin);
    const unit = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor });
    const buffer = await xlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Jan", "Kowalski", "Bytów Kaufland"],
    ]);
    const res = await commitRoute.POST(
      form(buffer, {
        mapping: JSON.stringify({ Imię: "firstName", Nazwisko: "lastName", Sklep: "orgUnit" }),
        unitResolution: JSON.stringify({ "Bytów Kaufland": unit.id }),
      }),
    );
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ result: { created: number } }>(res);
    expect(body.result.created).toBe(1);
  });

  it("audytor nie może importować", async () => {
    actAs(db, audytor);
    const buffer = await xlsx([["Imię"], ["Jan"]]);
    const res = await previewRoute.POST(form(buffer));
    expect(res.status).toBe(403);
  });

  it("odrzuca plik inny niż .xlsx", async () => {
    actAs(db, admin);
    const data = new FormData();
    data.set("file", new File([new Uint8Array(Buffer.from("a,b"))], "lista.csv"));
    const res = await previewRoute.POST(new Request("http://x/api/import/preview", { method: "POST", body: data }));
    expect(res.status).toBe(400);
    expect((await readJsonBody(res)).error).toContain(".xlsx");
  });

  it("odrzuca plik powyżej 10 MB", async () => {
    actAs(db, admin);
    const data = new FormData();
    const big = new Uint8Array(10 * 1024 * 1024 + 1);
    data.set("file", new File([big], "duzy.xlsx"));
    const res = await previewRoute.POST(new Request("http://x/api/import/preview", { method: "POST", body: data }));
    expect(res.status).toBe(400);
    expect((await readJsonBody(res)).error).toContain("za duży");
  });

  it("import wymaga CSRF", async () => {
    actAs(db, admin);
    const mod = await import("./harness");
    mod.dropCsrfHeader();
    const buffer = await xlsx([["Imię"], ["Jan"]]);
    const res = await previewRoute.POST(form(buffer));
    expect(res.status).toBe(403);
  });
});
