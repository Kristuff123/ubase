/** GET/POST /api/admin/org-units — jednostki organizacyjne. */
import { NextResponse } from "next/server";
import { canAdmin, requireEdit, requireUser } from "@/lib/auth/context";
import { createOrgUnit, listOrgUnits } from "@/lib/domain/org";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireUser();
    return NextResponse.json({ units: listOrgUnits(ctx.db) });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const body = await readJson<{
      type?: "region" | "zaklad" | "sklep" | "biuro";
      name?: string;
      number?: string;
      parentId?: number | null;
    }>(request);
    if (body.type === "region" && !canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Tylko administrator może dodawać regiony", code: "forbidden" }, { status: 403 });
    }
    const unit = createOrgUnit(ctx.db, {
      type: body.type ?? "sklep",
      name: body.name ?? "",
      number: body.number ?? null,
      parentId: body.parentId ?? null,
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
    });
    return NextResponse.json(unit, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
