/** PATCH (edycja) i DELETE (wycofanie) dostępu. */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { revokeAccess, updateAccess, type AccessInput } from "@/lib/domain/workers";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const { id } = await params;
    const body = await readJson<AccessInput>(request);
    updateAccess(ctx.db, Number(id), body, { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const { id } = await params;
    revokeAccess(ctx.db, Number(id), { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
