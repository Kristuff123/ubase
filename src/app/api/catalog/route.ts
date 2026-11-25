/** GET /api/catalog — kategorie dostępów, jednostki, opcje dla formularzy. */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/context";
import { listCategories, listOrgUnits, parseSchema } from "@/lib/domain/org";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireUser();
    const categories = listCategories(ctx.db, { activeOnly: true }).map((category) => ({
      id: category.id,
      slug: category.slug,
      name: category.name,
      icon: category.icon,
      fields: parseSchema(category),
    }));
    return NextResponse.json({
      categories,
      units: listOrgUnits(ctx.db).filter((unit) => unit.is_active === 1),
    });
  } catch (error) {
    return handleApiError(error);
  }
}
