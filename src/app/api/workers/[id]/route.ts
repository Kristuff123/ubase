/** GET/PATCH /api/workers/:id — szczegóły i edycja pracownika. */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { getWorkerDetail, updateWorker } from "@/lib/domain/workers";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const worker = getWorkerDetail(ctx.db, Number(id));
    if (!worker) return NextResponse.json({ error: "Pracownik nie istnieje", code: "not_found" }, { status: 404 });
    return NextResponse.json(worker);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const { id } = await params;
    const body = await readJson<{
      firstName?: string;
      lastName?: string;
      position?: string | null;
      orgUnitId?: number | null;
      email?: string | null;
      phone?: string | null;
      notes?: string | null;
    }>(request);
    updateWorker(ctx.db, Number(id), body, { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
