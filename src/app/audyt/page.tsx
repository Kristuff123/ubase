/** Audyt — log zdarzeń, weryfikacja łańcucha hash, eksport CSV. */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { AuditView } from "@/components/audit-view";

export const dynamic = "force-dynamic";

export default async function AuditPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");
  return <AuditView />;
}
