/** Strona główna: lista pracowników (Server Component + klient do interakcji). */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { getDb } from "@/db";
import { listCategories } from "@/lib/domain/org";
import { WorkerBrowser } from "@/components/worker-browser";

export const dynamic = "force-dynamic";

export default async function HomePage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");

  const db = getDb();
  const categories = listCategories(db, { activeOnly: true }).map((category) => ({
    slug: category.slug,
    name: category.name,
    icon: category.icon,
  }));

  return <WorkerBrowser categories={categories} role={user.role} currentUser={user.displayName} />;
}
