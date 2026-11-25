/** POST /api/workers/:id/archive|restore — archiwizacja i przywrócenie. */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { archiveWorker, restoreWorker } from "@/lib/domain/workers";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(_request: Request, { params }: { params: Promise<{ id: string; action: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const { id, action } = await params;
    const actor = { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip };
    if (action === "archive") archiveWorker(ctx.db, Number(id), actor);
    else if (action === "restore") restoreWorker(ctx.db, Number(id), actor);
    else return NextResponse.json({ error: "Nieznana operacja", code: "bad_action" }, { status: 400 });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
