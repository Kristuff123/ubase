/** Import z Excela — kreator 4-krokowy. */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { canEdit } from "@/lib/auth/context";
import { ImportWizard } from "@/components/import-wizard";

export const dynamic = "force-dynamic";

export default async function ImportPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");
  if (!canEdit(user.role)) redirect("/");
  return <ImportWizard />;
}
