/** GET /api/workers/:id/history — historia zmian pól pracownika. */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/context";
import { readHistory } from "@/lib/audit/log";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser();
    const { id } = await params;
    const workerHistory = readHistory(ctx.db, "worker", Number(id), 100);

    const accessIds = (
      ctx.db.prepare("SELECT id FROM accesses WHERE worker_id = ?").all(Number(id)) as { id: number }[]
    ).map((row) => row.id);
    const accessHistory = accessIds.flatMap((accessId) =>
      readHistory(ctx.db, "access", accessId, 50).map((entry) => ({ ...entry, accessId })),
    );

    const combined = [...workerHistory, ...accessHistory]
      .sort((a, b) => b.changed_at - a.changed_at)
      .slice(0, 200);

    return NextResponse.json({ entries: combined });
  } catch (error) {
    return handleApiError(error);
  }
}
