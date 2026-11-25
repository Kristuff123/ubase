/** Administracja — konta aplikacji, jednostki organizacyjne, kategorie dostępów. */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { canAdmin } from "@/lib/auth/context";
import { getDb } from "@/db";
import { listCategories, listOrgUnits, parseSchema } from "@/lib/domain/org";
import { AdminView } from "@/components/admin-view";

export const dynamic = "force-dynamic";

export default async function AdminPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");
  if (!canAdmin(user.role)) redirect("/");

  const db = getDb();
  const users = db
    .prepare(
      `SELECT id, username, display_name, role, totp_enabled, is_active, created_at, last_login_at
       FROM app_users ORDER BY created_at`,
    )
    .all() as {
    id: number;
    username: string;
    display_name: string;
    role: "admin" | "operator" | "audytor";
    totp_enabled: number;
    is_active: number;
    created_at: number;
    last_login_at: number | null;
  }[];

  const units = listOrgUnits(db).map((unit) => ({
    id: unit.id,
    type: unit.type,
    name: unit.name,
    number: unit.number,
    parent_id: unit.parent_id,
    is_active: unit.is_active,
  }));

  const categories = listCategories(db).map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    sort_order: category.sort_order,
    is_active: category.is_active,
    fields: parseSchema(category),
  }));

  return (
    <AdminView
      currentUserId={user.id}
      users={users}
      units={units}
      categories={categories}
      keys={
        db
          .prepare("SELECT version, created_at, retired_at FROM crypto_keys ORDER BY version DESC")
          .all() as { version: number; created_at: number; retired_at: number | null }[]
      }
    />
  );
}
