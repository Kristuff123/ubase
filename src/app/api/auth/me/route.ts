/** GET /api/auth/me — dane bieżącego użytkownika (dla UI). */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { HttpError, readClientIp, requireUser } from "@/lib/auth/context";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireUser();
    return NextResponse.json({
      user: {
        id: ctx.user.id,
        username: ctx.user.username,
        displayName: ctx.user.display_name,
        role: ctx.user.role,
        totpEnabled: ctx.user.totp_enabled === 1,
        mustChangePassword: ctx.user.must_change_password === 1,
      },
      db: getDb() !== null,
      ip: await readClientIp(),
    });
  } catch (error) {
    if (error instanceof HttpError) return handleApiError(error);
    return handleApiError(error);
  }
}
