/** Kartoteka pracownika — dane, dostępy, historia, archiwum, eksport RODO. */
import { notFound, redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { getDb } from "@/db";
import { getWorkerDetail } from "@/lib/domain/workers";
import { listCategories, listOrgUnits, parseSchema } from "@/lib/domain/org";
import { WorkerDetailView } from "@/components/worker-detail";

export const dynamic = "force-dynamic";

export default async function WorkerPage({ params }: { params: Promise<{ id: string }> }) {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");

  const { id } = await params;
  const workerId = Number(id);
  if (!Number.isInteger(workerId)) notFound();

  const db = getDb();
  const worker = getWorkerDetail(db, workerId);
  if (!worker) notFound();

  const units = listOrgUnits(db)
    .filter((unit) => unit.is_active === 1)
    .map((unit) => ({ id: unit.id, type: unit.type, name: unit.name, number: unit.number }));

  const categories = listCategories(db, { activeOnly: true }).map((category) => ({
    id: category.id,
    slug: category.slug,
    name: category.name,
    fields: parseSchema(category),
  }));

  return <WorkerDetailView worker={worker} role={user.role} units={units} categories={categories} />;
}
