/** POST /api/account/password — zmiana własnego hasła. */
import { NextResponse } from "next/server";
import { getDb } from "@/db";
import { requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { hashPassword, verifyPassword } from "@/lib/crypto/password";
import { destroyAllUserSessions } from "@/lib/auth/session";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request) {
  try {
    const ctx = await requireUser({ write: true });
    const body = await readJson<{ currentPassword?: string; newPassword?: string }>(request);
    if (!body.currentPassword || !body.newPassword) {
      return NextResponse.json({ error: "Podaj oba hasła", code: "validation" }, { status: 400 });
    }
    if (body.newPassword.length < 12) {
      return NextResponse.json({ error: "Nowe hasło musi mieć co najmniej 12 znaków", code: "validation" }, { status: 400 });
    }

    const row = getDb().prepare("SELECT password_hash FROM app_users WHERE id = ?").get(ctx.user.id) as {
      password_hash: string;
    };
    if (!(await verifyPassword(row.password_hash, body.currentPassword))) {
      return NextResponse.json({ error: "Nieprawidłowe obecne hasło", code: "invalid_password" }, { status: 401 });
    }

    const hash = await hashPassword(body.newPassword);
    ctx.db.prepare("UPDATE app_users SET password_hash = ?, must_change_password = 0 WHERE id = ?").run(hash, ctx.user.id);
    destroyAllUserSessions(ctx.db, ctx.user.id, ctx.session.id);
    appendAudit(ctx.db, {
      action: "auth.password_changed",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Zmieniono własne hasło: ${ctx.user.username}`,
      entityType: "app_user",
      entityId: ctx.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
