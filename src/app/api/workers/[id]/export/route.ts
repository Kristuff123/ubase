/**
 * GET /api/workers/:id/export — eksport danych pracownika (RODO).
 * Sekrety domyślnie pominięte; `includeSecrets=1` wymaga roli admin/operator i jest logowane.
 */
import { NextResponse } from "next/server";
import { canReveal, requireUser } from "@/lib/auth/context";
import { exportWorkerData, getWorkerDetail } from "@/lib/domain/workers";
import { contentDisposition } from "@/lib/http";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const url = new URL(request.url);
    const includeSecrets = url.searchParams.get("includeSecrets") === "1";

    if (includeSecrets && !canReveal(ctx.user.role)) {
      return NextResponse.json({ error: "Brak uprawnień do eksportu sekretów", code: "forbidden" }, { status: 403 });
    }

    const data = exportWorkerData(ctx.db, Number(id), {
      includeSecrets,
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
    });
    const detail = getWorkerDetail(ctx.db, Number(id));
    const name = detail ? `${detail.lastName}-${detail.firstName}` : String(id);

    return new Response(JSON.stringify(data, null, 2), {
      headers: {
        "Content-Type": "application/json; charset=utf-8",
        "Content-Disposition": contentDisposition(`pracownik-${name}.json`),
        "Cache-Control": "no-store",
      },
    });
  } catch (error) {
    return handleApiError(error);
  }
}
