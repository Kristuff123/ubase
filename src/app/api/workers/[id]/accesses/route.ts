/** GET/POST /api/workers/:id/accesses — dodawanie dostępu do pracownika. */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { addAccess, type AccessInput } from "@/lib/domain/workers";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const { id } = await params;
    const body = await readJson<AccessInput>(request);
    const accessId = addAccess(ctx.db, Number(id), body, {
      userId: ctx.user.id,
      name: ctx.user.display_name,
      ip: ctx.ip,
    });
    return NextResponse.json({ id: accessId }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
