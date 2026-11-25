/** POST /api/auth/2fa — krok 2: kod TOTP lub kod odzyskiwania. */
import { cookies } from "next/headers";
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { completeTwoFactor, type AppUserRow } from "@/lib/auth/service";
import { CSRF_COOKIE, SESSION_COOKIE, lookupSession } from "@/lib/auth/session";
import { clientIpFromHeaders } from "@/lib/auth/context";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson<{ code?: string }>(request);
    if (!body.code) {
      return NextResponse.json({ error: "Podaj kod", code: "validation" }, { status: 400 });
    }

    const cookieStore = await cookies();
    const db = getDb();
    const found = lookupSession(db, cookieStore.get(SESSION_COOKIE)?.value);
    if (found.kind !== "pending") {
      return NextResponse.json({ error: "Brak sesji oczekującej na kod", code: "no_pending" }, { status: 401 });
    }

    const user = db.prepare("SELECT * FROM app_users WHERE id = ?").get(found.session.user_id) as AppUserRow;
    completeTwoFactor(db, {
      session: found.session,
      user,
      code: body.code,
      ip: clientIpFromHeaders(request.headers),
    });

    // Po promocji sesja jest pełna — wydłużamy cookie.
    const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1";
    const response = NextResponse.json({
      status: "active",
      user: {
        username: user.username,
        displayName: user.display_name,
        role: user.role,
        mustChangePassword: user.must_change_password === 1,
      },
    });
    const csrf = cookieStore.get(CSRF_COOKIE)?.value;
    if (csrf) {
      response.cookies.set(CSRF_COOKIE, csrf, {
        httpOnly: false,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: 12 * 60 * 60,
      });
    }
    const token = cookieStore.get(SESSION_COOKIE)?.value;
    if (token) {
      response.cookies.set(SESSION_COOKIE, token, {
        httpOnly: true,
        sameSite: "lax",
        secure,
        path: "/",
        maxAge: 12 * 60 * 60,
      });
    }
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
