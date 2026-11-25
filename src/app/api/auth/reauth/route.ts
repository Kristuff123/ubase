/** POST /api/auth/reauth — ponowne potwierdzenie hasła (bramka do sekretów i operacji wrażliwych). */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { reauthenticate, type AppUserRow } from "@/lib/auth/service";
import { requireUser } from "@/lib/auth/context";
import { markReauthenticated } from "@/lib/auth/session";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ctx = await requireUser({ write: true });
    const body = await readJson<{ password?: string }>(request);
    if (!body.password) {
      return NextResponse.json({ error: "Podaj hasło", code: "validation" }, { status: 400 });
    }
    const row = getDb().prepare("SELECT * FROM app_users WHERE id = ?").get(ctx.user.id) as AppUserRow;
    const ok = await reauthenticate(getDb(), { user: row, password: body.password, ip: ctx.ip });
    if (!ok) return NextResponse.json({ error: "Nieprawidłowe hasło", code: "invalid_password" }, { status: 401 });
    // Znacznik trafia do sesji w bazie — reveal sprawdzi go po stronie serwera.
    markReauthenticated(getDb(), ctx.session.id);
    return NextResponse.json({ ok: true, validForSeconds: 300 });
  } catch (error) {
    return handleApiError(error);
  }
}
