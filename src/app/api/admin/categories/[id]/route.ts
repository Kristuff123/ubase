/** PATCH /api/admin/categories/:id — nazwa, kolejność, aktywacja kategorii (tylko admin). */
import { NextResponse } from "next/server";
import { canAdmin, requireUser } from "@/lib/auth/context";
import { setCustomFields, updateCategory } from "@/lib/domain/org";
import type { FieldSchema } from "@/lib/domain/types";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    if (!canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Brak uprawnień", code: "forbidden" }, { status: 403 });
    }
    const { id } = await params;
    const body = await readJson<{
      name?: string;
      sortOrder?: number;
      isActive?: boolean;
      customFields?: FieldSchema;
    }>(request);

    const actor = { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip };

    if (body.customFields) {
      setCustomFields(ctx.db, body.customFields, actor);
    }
    if (body.name !== undefined || body.sortOrder !== undefined || body.isActive !== undefined) {
      updateCategory(ctx.db, Number(id), { name: body.name, sortOrder: body.sortOrder, isActive: body.isActive, actor });
    }
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
