/** Wspólna obsługa uploadu .xlsx dla podglądu i importu. */
import { NextResponse } from "next/server";
import { HttpError, requireEdit, requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { commitImport, parseWorkbook, previewImport, type ImportMapping } from "@/lib/domain/import";
import { handleApiError } from "@/lib/api";

const MAX_BYTES = 10 * 1024 * 1024;

export type Upload = {
  fileName: string;
  buffer: Buffer;
  mapping: ImportMapping | null;
  unitResolution: Record<string, number> | undefined;
  createMissingUnits: boolean;
  onlyValid: boolean;
};

export async function readUpload(request: Request): Promise<Upload> {
  const form = await request.formData();
  const file = form.get("file");
  if (!(file instanceof File)) throw new HttpError(400, "Brak pliku", "validation");
  if (file.size > MAX_BYTES) throw new HttpError(400, "Plik jest za duży (limit 10 MB)", "validation");
  if (!file.name.toLowerCase().endsWith(".xlsx")) {
    throw new HttpError(400, "Dozwolone są wyłącznie pliki .xlsx", "validation");
  }

  const mappingRaw = form.get("mapping");
  const mapping = typeof mappingRaw === "string" && mappingRaw.trim() ? (JSON.parse(mappingRaw) as ImportMapping) : null;

  const unitResolutionRaw = form.get("unitResolution");
  const unitResolution =
    typeof unitResolutionRaw === "string" && unitResolutionRaw.trim()
      ? (JSON.parse(unitResolutionRaw) as Record<string, number>)
      : undefined;

  return {
    fileName: file.name,
    buffer: Buffer.from(await file.arrayBuffer()),
    mapping,
    unitResolution,
    createMissingUnits: form.get("createMissingUnits") === "1",
    onlyValid: form.get("onlyValid") !== "0",
  };
}

export async function handlePreview(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const upload = await readUpload(request);
    const sheet = await parseWorkbook(upload.buffer);
    const preview = previewImport(ctx.db, sheet, {
      mapping: upload.mapping ?? {},
      unitResolution: upload.unitResolution,
      createMissingUnits: upload.createMissingUnits,
    });
    appendAudit(ctx.db, {
      action: "import.previewed",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Podgląd importu „${upload.fileName}": ${preview.summary.total} wierszy`,
      details: { fileName: upload.fileName, summary: preview.summary },
    });
    return NextResponse.json({
      phase: "preview",
      sheet: { columns: sheet.columns, rowCount: sheet.rows.length },
      preview,
    });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function handleCommit(request: Request): Promise<NextResponse> {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const upload = await readUpload(request);
    const sheet = await parseWorkbook(upload.buffer);
    const result = commitImport(
      ctx.db,
      sheet,
      {
        mapping: upload.mapping ?? {},
        unitResolution: upload.unitResolution,
        createMissingUnits: upload.createMissingUnits,
      },
      { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      { onlyValid: upload.onlyValid, fileName: upload.fileName },
    );
    return NextResponse.json({ phase: "commit", result });
  } catch (error) {
    return handleApiError(error);
  }
}
