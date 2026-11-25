/** GET /api/audit — log zdarzeń z filtrami; GET /api/audit/verify — weryfikacja łańcucha. */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/context";
import { readAuditRange } from "@/lib/audit/log";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ctx = await requireUser();
    const url = new URL(request.url);
    const from = url.searchParams.get("from");
    const to = url.searchParams.get("to");
    const rows = readAuditRange(ctx.db, {
      from: from ? Date.parse(from) : undefined,
      to: to ? Date.parse(to) : undefined,
      actorId: url.searchParams.get("actor") ? Number(url.searchParams.get("actor")) : undefined,
      action: url.searchParams.get("action") ?? undefined,
      entityType: url.searchParams.get("entityType") ?? undefined,
      entityId: url.searchParams.get("entityId") ? Number(url.searchParams.get("entityId")) : undefined,
      limit: Number(url.searchParams.get("limit") ?? 100),
      offset: Number(url.searchParams.get("offset") ?? 0),
    });

    return NextResponse.json({
      events: rows.map((row) => ({
        seq: row.seq,
        at: row.at,
        actorName: row.actor_name,
        actorIp: row.actor_ip,
        action: row.action,
        entityType: row.entity_type,
        entityId: row.entity_id,
        summary: row.summary,
        details: row.details_json ? JSON.parse(row.details_json) : null,
        entryHash: row.entry_hash,
        prevHash: row.prev_hash,
      })),
      actions: (
        ctx.db.prepare("SELECT action, COUNT(*) AS c FROM audit_events GROUP BY action ORDER BY action").all() as {
          action: string;
          c: number;
        }[]
      ).map((row) => ({ action: row.action, count: row.c })),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
