/** GET/POST /api/admin/users — konta aplikacji (tylko admin). */
import { NextResponse } from "next/server";
import { canAdmin, requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { hashPassword } from "@/lib/crypto/password";
import { generatePassword } from "@/lib/crypto/password-gen";
import { handleApiError, readJson } from "@/lib/api";

/** Limit kont aplikacji — dział IT, pięć osób. Egzekwowany serwerowo, nie tylko w UI. */
export const MAX_ACTIVE_USERS = 5;

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireUser();
    if (!canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Brak uprawnień", code: "forbidden" }, { status: 403 });
    }
    const users = ctx.db
      .prepare(
        `SELECT id, username, display_name, role, totp_enabled, is_active, created_at, last_login_at
         FROM app_users ORDER BY created_at`,
      )
      .all();
    return NextResponse.json({ users });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function POST(request: Request) {
  try {
    const ctx = await requireUser({ write: true });
    if (!canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Brak uprawnień", code: "forbidden" }, { status: 403 });
    }
    const body = await readJson<{
      username?: string;
      displayName?: string;
      role?: "admin" | "operator" | "audytor";
      password?: string;
    }>(request);

    const username = body.username?.trim().toLowerCase();
    if (!username || !/^[a-z0-9._-]{3,32}$/.test(username)) {
      return NextResponse.json(
        { error: "Login: 3–32 znaki, małe litery, cyfry, kropka, podkreślenie, myślnik", code: "validation" },
        { status: 400 },
      );
    }
    if (!body.displayName?.trim()) {
      return NextResponse.json({ error: "Podaj imię i nazwisko", code: "validation" }, { status: 400 });
    }
    if (!body.role || !["admin", "operator", "audytor"].includes(body.role)) {
      return NextResponse.json({ error: "Nieprawidłowa rola", code: "validation" }, { status: 400 });
    }

    const existing = ctx.db.prepare("SELECT id FROM app_users WHERE username = ? COLLATE NOCASE").get(username);
    if (existing) {
      return NextResponse.json({ error: "Taki login już istnieje", code: "conflict" }, { status: 409 });
    }

    const active = (
      ctx.db.prepare("SELECT COUNT(*) AS c FROM app_users WHERE is_active = 1").get() as { c: number }
    ).c;
    if (active >= MAX_ACTIVE_USERS) {
      return NextResponse.json(
        {
          error: `Limit ${MAX_ACTIVE_USERS} aktywnych kont został osiągnięty. Wyłącz konto, którego już nie używasz.`,
          code: "user_limit",
        },
        { status: 409 },
      );
    }

    const generated = !body.password;
    const password = body.password ?? generatePassword({ length: 16, maxDigits: 4 }).password;
    if (password.length < 12) {
      return NextResponse.json({ error: "Hasło musi mieć co najmniej 12 znaków", code: "validation" }, { status: 400 });
    }

    const hash = await hashPassword(password);
    const id = ctx.db
      .prepare(
        `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(username, body.displayName.trim(), body.role, hash, generated ? 1 : 0, Date.now()).lastInsertRowid as number;

    appendAudit(ctx.db, {
      action: "user.created",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Utworzono konto ${username} (${body.role})`,
      entityType: "app_user",
      entityId: id,
    });

    return NextResponse.json({ id, password: generated ? password : undefined }, { status: 201 });
  } catch (error) {
    return handleApiError(error);
  }
}
