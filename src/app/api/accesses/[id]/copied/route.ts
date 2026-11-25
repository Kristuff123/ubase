/** POST /api/accesses/:id/copied — audyt skopiowania sekretu do schowka. */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    const body = await readJson<{ fieldKey?: string }>(request);
    const { id } = await params;
    appendAudit(ctx.db, {
      action: "secret.copied",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Skopiowano sekret „${body.fieldKey ?? "?"}" do schowka`,
      entityType: "access",
      entityId: Number(id),
      details: { field: body.fieldKey },
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
