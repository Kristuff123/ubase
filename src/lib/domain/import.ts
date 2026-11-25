/**
 * Import z Excela — lista użytkowników (v1).
 *
 * Kreator: podgląd z mapowaniem kolumn → walidacja wierszy → import w transakcji.
 * Jednostki organizacyjne nie są tworzone po cichu: nieznane nazwy trafiają do
 * `unknownUnits` i wymagają decyzji w UI.
 */
import ExcelJS from "exceljs";
import type { Db } from "@/db";
import { appendAudit, type AuditActor } from "@/lib/audit/log";
import { createWorker, findDuplicateWorker } from "./workers";
import { createOrgUnit, listOrgUnits } from "./org";
import { foldDiacritics } from "@/lib/utils";
import type { ImportPreview, ImportPreviewRow } from "./types";

export const IMPORT_COLUMNS = [
  { key: "firstName", label: "Imię" },
  { key: "lastName", label: "Nazwisko" },
  { key: "fullName", label: "Imię i nazwisko" },
  { key: "position", label: "Stanowisko / rola" },
  { key: "orgUnit", label: "Sklep / zakład / jednostka" },
  { key: "email", label: "E-mail" },
  { key: "phone", label: "Telefon" },
  { key: "ignore", label: "Pomiń kolumnę" },
] as const;

export type ImportColumnKey = (typeof IMPORT_COLUMNS)[number]["key"];

export type ImportMapping = Record<string, ImportColumnKey>;

export type ParsedSheet = {
  columns: string[];
  rows: Record<string, string>[];
};

/** Wczytuje pierwszy arkusz pliku .xlsx jako tekst. */
export async function parseWorkbook(buffer: Buffer): Promise<ParsedSheet> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
  const sheet = workbook.worksheets[0];
  if (!sheet) throw new Error("Plik nie zawiera żadnego arkusza");

  const headerRow = sheet.getRow(1);
  const columns: string[] = [];
  headerRow.eachCell({ includeEmpty: false }, (cell, colNumber) => {
    const value = cellText(cell.value);
    columns[colNumber - 1] = value || `Kolumna ${colNumber}`;
  });

  // Usuwamy puste nagłówki na końcu.
  while (columns.length && !columns[columns.length - 1]) columns.pop();

  const rows: Record<string, string>[] = [];
  const maxRow = Math.min(sheet.rowCount, 5001); // limit bezpieczeństwa
  for (let rowNumber = 2; rowNumber <= maxRow; rowNumber += 1) {
    const row = sheet.getRow(rowNumber);
    const record: Record<string, string> = {};
    let hasValue = false;
    columns.forEach((name, index) => {
      const text = cellText(row.getCell(index + 1).value).trim();
      record[name] = text;
      if (text) hasValue = true;
    });
    if (hasValue) rows.push(record);
  }

  return { columns, rows };
}

function cellText(value: ExcelJS.CellValue): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === "object") {
    const rich = value as { richText?: { text: string }[]; text?: string; result?: unknown; formula?: string };
    if (Array.isArray(rich.richText)) return rich.richText.map((r) => r.text).join("");
    if (typeof rich.text === "string") return rich.text;
    if (rich.result !== undefined) return String(rich.result);
    if (rich.formula) return "";
  }
  return String(value);
}

/** Heurystyka: dopasowanie nagłówków do pól na podstawie nazw. */
export function suggestMapping(columns: string[]): ImportMapping {
  const mapping: ImportMapping = {};
  for (const column of columns) {
    const normalized = foldDiacritics(column);
    if (/^(imie|imię)$|^first.?name$/.test(normalized)) mapping[column] = "firstName";
    else if (/^(nazwisko)$|^last.?name$/.test(normalized)) mapping[column] = "lastName";
    else if (/imie i nazwisko|nazwisko i imie|full.?name|pracownik/.test(normalized)) mapping[column] = "fullName";
    else if (/stanowisko|rola|position|funkcja/.test(normalized)) mapping[column] = "position";
    else if (/sklep|zaklad|lokalizacja|jednostka|store|region|oddzial/.test(normalized)) mapping[column] = "orgUnit";
    else if (/mail|e-?mail/.test(normalized)) mapping[column] = "email";
    else if (/telefon|phone|komorka|tel/.test(normalized)) mapping[column] = "phone";
    else if (/login|user|konto/.test(normalized)) mapping[column] = "ignore";
    else mapping[column] = "ignore";
  }
  return mapping;
}

function splitFullName(value: string): { firstName: string; lastName: string } {
  const parts = value.trim().split(/\s+/).filter(Boolean);
  if (parts.length === 0) return { firstName: "", lastName: "" };
  if (parts.length === 1) return { firstName: parts[0], lastName: "" };
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") };
}

export type ImportOptions = {
  mapping: ImportMapping;
  /** Nazwy jednostek z pliku → id istniejącej jednostki. */
  unitResolution?: Record<string, number>;
  /** Czy tworzyć nowe jednostki (typ sklep) dla nieznanych nazw. */
  createMissingUnits?: boolean;
};

/** Podgląd importu — bez zapisu do bazy. */
export function previewImport(db: Db, sheet: ParsedSheet, options: ImportOptions): ImportPreview {
  const units = listOrgUnits(db);
  const unitByName = new Map<string, number>();
  for (const unit of units) unitByName.set(foldDiacritics(unit.name), unit.id);

  const unknownUnits = new Set<string>();
  const rows: ImportPreviewRow[] = [];
  // Wiersze, które commit faktycznie zapisze przy onlyValid=true: bez błędów
  // i z rozpoznaną jednostką. Wiersz „uwaga" bez jednostki jest pomijany.
  let importable = 0;

  sheet.rows.forEach((raw, index) => {
    const values: Record<string, string> = {};
    for (const [column, key] of Object.entries(options.mapping)) {
      if (key === "ignore") continue;
      values[key] = raw[column] ?? "";
    }

    let firstName = values.firstName?.trim() ?? "";
    let lastName = values.lastName?.trim() ?? "";
    if (values.fullName && (!firstName || !lastName)) {
      const split = splitFullName(values.fullName);
      firstName = firstName || split.firstName;
      lastName = lastName || split.lastName;
    }

    const orgUnitName = values.orgUnit?.trim() || null;
    const messages: string[] = [];
    let status: ImportPreviewRow["status"] = "ok";

    if (!firstName) {
      messages.push("Brak imienia");
      status = "error";
    }
    if (!lastName) {
      messages.push("Brak nazwiska");
      status = "error";
    }

    let orgUnitId: number | null = null;
    if (orgUnitName) {
      const folded = foldDiacritics(orgUnitName);
      const resolved = options.unitResolution?.[orgUnitName] ?? unitByName.get(folded) ?? null;
      if (resolved) {
        orgUnitId = resolved;
      } else {
        unknownUnits.add(orgUnitName);
        messages.push(`Nieznana jednostka: ${orgUnitName}`);
        if (status === "ok") status = "warning";
      }
    } else {
      messages.push("Brak jednostki");
      if (status === "ok") status = "warning";
    }

    if (status !== "error" && findDuplicateWorker(db, { firstName, lastName, orgUnitId })) {
      messages.push("Pracownik już istnieje w tej jednostce");
      status = "duplicate";
    }

    const email = values.email?.trim() || null;
    if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      messages.push("Nieprawidłowy adres e-mail");
      if (status === "ok") status = "warning";
    }

    // Liczy się to, co zrobi commit: status inny niż błąd/duplikat ORAZ jednostka
    // (rozpoznana albo do utworzenia, gdy createMissingUnits jest włączone).
    const willHaveUnit = orgUnitId !== null || (orgUnitName !== null && options.createMissingUnits === true);
    if (status !== "error" && status !== "duplicate" && willHaveUnit) {
      importable += 1;
    }

    rows.push({
      rowNumber: index + 2,
      values: raw,
      status,
      messages,
      normalized: {
        firstName,
        lastName,
        position: values.position?.trim() || null,
        email,
        phone: values.phone?.trim() || null,
        orgUnitName,
      },
    });
  });

  const summary = {
    total: rows.length,
    ok: rows.filter((r) => r.status === "ok").length,
    duplicate: rows.filter((r) => r.status === "duplicate").length,
    error: rows.filter((r) => r.status === "error").length,
    warning: rows.filter((r) => r.status === "warning").length,
  };

  return {
    columns: sheet.columns,
    suggestedMapping: suggestMapping(sheet.columns),
    rows,
    unknownUnits: [...unknownUnits],
    summary,
    importable,
  };
}

export type ImportResult = {
  created: number;
  skipped: number;
  errors: { rowNumber: number; message: string }[];
};

/**
 * Wykonuje import. `onlyValid` = pomiń wiersze z błędami zamiast przerywać całość.
 */
export function commitImport(
  db: Db,
  sheet: ParsedSheet,
  options: ImportOptions,
  actor: AuditActor,
  flags: { onlyValid: boolean; fileName: string },
): ImportResult {
  const preview = previewImport(db, sheet, options);
  const result: ImportResult = { created: 0, skipped: 0, errors: [] };

  const units = listOrgUnits(db);
  const unitByName = new Map<string, number>();
  for (const unit of units) unitByName.set(foldDiacritics(unit.name), unit.id);

  const run = db.transaction(() => {
    for (const row of preview.rows) {
      if (row.status === "error" || row.status === "duplicate") {
        result.skipped += 1;
        if (row.status === "error") {
          result.errors.push({ rowNumber: row.rowNumber, message: row.messages.join("; ") });
        }
        continue;
      }
      if (!row.normalized) {
        result.skipped += 1;
        continue;
      }
      let orgUnitId: number | null = null;
      if (row.normalized.orgUnitName) {
        orgUnitId =
          options.unitResolution?.[row.normalized.orgUnitName] ??
          unitByName.get(foldDiacritics(row.normalized.orgUnitName)) ??
          null;
        if (!orgUnitId && options.createMissingUnits) {
          const created = createOrgUnit(db, {
            type: "sklep",
            name: row.normalized.orgUnitName,
            actor,
          });
          orgUnitId = created.id;
          unitByName.set(foldDiacritics(created.name), created.id);
        }
      }
      if (!orgUnitId) {
        result.skipped += 1;
        result.errors.push({ rowNumber: row.rowNumber, message: "Nieprzypisana jednostka" });
        if (!flags.onlyValid) throw new Error(`Wiersz ${row.rowNumber}: nieprzypisana jednostka`);
        continue;
      }

      createWorker(
        db,
        {
          firstName: row.normalized.firstName,
          lastName: row.normalized.lastName,
          position: row.normalized.position,
          orgUnitId,
          email: row.normalized.email,
          phone: row.normalized.phone,
        },
        actor,
      );
      result.created += 1;
    }

    appendAudit(db, {
      action: "import.committed",
      actor,
      summary: `Import z pliku „${flags.fileName}": dodano ${result.created}, pominięto ${result.skipped}`,
      details: { fileName: flags.fileName, created: result.created, skipped: result.skipped },
    });
  });

  run();
  return result;
}
