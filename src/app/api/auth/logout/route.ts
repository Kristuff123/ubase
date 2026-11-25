/** POST /api/auth/logout — kończy sesję i czyści cookies. */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { appendAudit } from "@/lib/audit/log";
import { CSRF_COOKIE, SESSION_COOKIE, destroySession, lookupSession } from "@/lib/auth/session";
import { clientIpFromHeaders } from "@/lib/auth/context";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const cookieStore = await cookies();
    const db = getDb();
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    const found = lookupSession(db, token);
    if (found.kind === "active" || found.kind === "pending") {
      const user = db
        .prepare("SELECT id, username, display_name FROM app_users WHERE id = ?")
        .get(found.session.user_id) as { id: number; username: string; display_name: string } | undefined;
      if (user) {
        appendAudit(db, {
          action: "auth.logout",
          actor: { userId: user.id, name: user.display_name, ip: clientIpFromHeaders(request.headers) },
          summary: `Wylogowano: ${user.username}`,
          entityType: "app_user",
          entityId: user.id,
        });
      }
      destroySession(db, found.session.id);
    }

    const response = NextResponse.json({ ok: true });
    response.cookies.delete(SESSION_COOKIE);
    response.cookies.delete(CSRF_COOKIE);
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
