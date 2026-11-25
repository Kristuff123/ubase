/** Moje konto — zmiana hasła, 2FA (QR + kody odzyskiwania). */
import { redirect } from "next/navigation";
import { getSessionUser } from "@/lib/auth/server";
import { AccountView } from "@/components/account-view";

export const dynamic = "force-dynamic";

export default async function AccountPage() {
  const user = await getSessionUser();
  if (!user) redirect("/login?expired=1");
  return <AccountView user={user} />;
}
