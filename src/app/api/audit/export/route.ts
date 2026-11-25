/** GET /api/audit/export — eksport logu do CSV (dla audytora). */
import { requireUser } from "@/lib/auth/context";
import { appendAudit, readAuditRange } from "@/lib/audit/log";
import { formatDateTime } from "@/lib/utils";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

function csvCell(value: unknown): string {
  const text = value === null || value === undefined ? "" : String(value);
  if (/[";\n\r]/.test(text)) return `"${text.replace(/"/g, '""')}"`;
  return text;
}

export async function GET(request: Request) {
  try {
    const ctx = await requireUser();
    const url = new URL(request.url);
    const rows = readAuditRange(ctx.db, {
      from: url.searchParams.get("from") ? Date.parse(url.searchParams.get("from")!) : undefined,
      to: url.searchParams.get("to") ? Date.parse(url.searchParams.get("to")!) : undefined,
      action: url.searchParams.get("action") ?? undefined,
      limit: 1000,
    });

    appendAudit(ctx.db, {
      action: "audit.exported",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Wyeksportowano log audytowy (${rows.length} wpisów)`,
    });

    const header = ["seq", "czas", "uzytkownik", "ip", "akcja", "typ", "id", "opis", "hash", "poprzedni_hash"];
    const lines = [header.join(";")];
    for (const row of rows) {
      lines.push(
        [
          row.seq,
          formatDateTime(row.at),
          row.actor_name ?? "",
          row.actor_ip ?? "",
          row.action,
          row.entity_type ?? "",
          row.entity_id ?? "",
          row.summary,
          row.entry_hash,
          row.prev_hash,
        ]
          .map(csvCell)
          .join(";"),
      );
    }

    const csv = `\uFEFF${lines.join("\r\n")}`;
    return new Response(csv, {
      headers: {
        "Content-Type": "text/csv; charset=utf-8",
        "Content-Disposition": `attachment; filename="audyt-${new Date().toISOString().slice(0, 10)}.csv"`,
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
