/**
 * POST /api/auth/login — krok 1: login i hasło.
 * Ustawia cookie sesji (pełnej lub pending_2fa) oraz cookie CSRF.
 */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { login } from "@/lib/auth/service";
import { CSRF_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";
import { clientIpFromHeaders } from "@/lib/auth/context";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const body = await readJson<{ username?: string; password?: string }>(request);
    if (!body.username || !body.password) {
      return NextResponse.json({ error: "Podaj login i hasło", code: "validation" }, { status: 400 });
    }

    const ip = clientIpFromHeaders(request.headers);
    const result = await login(getDb(), {
      username: body.username,
      password: body.password,
      ip,
      userAgent: request.headers.get("user-agent"),
    });

    const secure = process.env.NODE_ENV === "production" || process.env.COOKIE_SECURE === "1";
    const response = NextResponse.json({
      status: result.kind,
      user: {
        username: result.user.username,
        displayName: result.user.display_name,
        role: result.user.role,
        mustChangePassword: result.user.must_change_password === 1,
      },
    });

    response.cookies.set(SESSION_COOKIE, result.token, {
      httpOnly: true,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: result.kind === "pending_2fa" ? 300 : 12 * 60 * 60,
    });
    response.cookies.set(CSRF_COOKIE, result.csrfToken, {
      httpOnly: false,
      sameSite: "lax",
      secure,
      path: "/",
      maxAge: result.kind === "pending_2fa" ? 300 : 12 * 60 * 60,
    });
    return response;
  } catch (error) {
    return handleApiError(error);
  }
}
