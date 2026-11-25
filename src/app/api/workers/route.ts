/** GET/POST /api/workers — lista z wyszukiwaniem i tworzenie pracownika. */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { createWorker, findDuplicateWorker, listWorkers } from "@/lib/domain/workers";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ctx = await requireUser();
    const url = new URL(request.url);
    const statusParam = url.searchParams.get("status");
    const status =
      statusParam === "archiwum" || statusParam === "zarchiwizowany"
        ? "zarchiwizowany"
        : statusParam === "wszyscy"
          ? "wszyscy"
          : "aktywny";
    const result = listWorkers(ctx.db, {
      q: url.searchParams.get("q") ?? undefined,
      status,
      categorySlug: url.searchParams.get("category") ?? undefined,
      limit: Number(url.searchParams.get("limit") ?? 50),
      offset: Number(url.searchParams.get("offset") ?? 0),
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireUser({ write: true });
    requireEdit(ctx);
    const body = await readJson<{
      firstName?: string;
      lastName?: string;
      position?: string;
      orgUnitId?: number | null;
      email?: string;
      phone?: string;
      notes?: string;
      force?: boolean;
    }>(request);

    const duplicate = findDuplicateWorker(ctx.db, {
      firstName: body.firstName ?? "",
      lastName: body.lastName ?? "",
      orgUnitId: body.orgUnitId ?? null,
    });
    if (duplicate && !body.force) {
      return NextResponse.json(
        {
          error: "Taki pracownik już istnieje w tej jednostce",
          code: "duplicate",
          duplicate: { id: duplicate.id, firstName: duplicate.first_name, lastName: duplicate.last_name },
        },
        { status: 409 },
      );
    }

    const worker = createWorker(
      ctx.db,
      {
        firstName: body.firstName ?? "",
        lastName: body.lastName ?? "",
        position: body.position,
        orgUnitId: body.orgUnitId ?? null,
        email: body.email,
        phone: body.phone,
        notes: body.notes,
      },
      { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
    );
    return NextResponse.json({ id: worker.id }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
