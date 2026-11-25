/** PATCH /api/admin/users/:id — zmiana roli, dezaktywacja, reset hasła (tylko admin). */
import { NextResponse } from "next/server";
import { canAdmin, requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { hashPassword } from "@/lib/crypto/password";
import { generatePassword } from "@/lib/crypto/password-gen";
import { destroyAllUserSessions } from "@/lib/auth/session";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function PATCH(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    if (!canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Brak uprawnień", code: "forbidden" }, { status: 403 });
    }
    const { id } = await params;
    const userId = Number(id);
    const target = ctx.db.prepare("SELECT * FROM app_users WHERE id = ?").get(userId) as
      | { id: number; username: string; display_name: string; role: string; is_active: number }
      | undefined;
    if (!target) return NextResponse.json({ error: "Konto nie istnieje", code: "not_found" }, { status: 404 });

    const body = await readJson<{
      role?: "admin" | "operator" | "audytor";
      displayName?: string;
      isActive?: boolean;
      resetPassword?: boolean;
      resetTotp?: boolean;
    }>(request);

    const actor = { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip };

    // Ochrona: nie można odebrać sobie ostatniego aktywnego admina.
    if ((body.role && body.role !== "admin") || body.isActive === false) {
      const admins = ctx.db
        .prepare("SELECT COUNT(*) AS c FROM app_users WHERE role = 'admin' AND is_active = 1")
        .get() as { c: number };
      if (target.role === "admin" && admins.c <= 1) {
        return NextResponse.json(
          { error: "To ostatnie aktywne konto administratora — nie można go zdegradować ani wyłączyć", code: "last_admin" },
          { status: 400 },
        );
      }
    }

    let newPassword: string | undefined;

    if (body.role) {
      ctx.db.prepare("UPDATE app_users SET role = ? WHERE id = ?").run(body.role, userId);
      appendAudit(ctx.db, {
        action: "user.updated",
        actor,
        summary: `Zmieniono rolę ${target.username}: ${target.role} → ${body.role}`,
        entityType: "app_user",
        entityId: userId,
      });
      destroyAllUserSessions(ctx.db, userId);
    }

    if (body.displayName?.trim()) {
      ctx.db.prepare("UPDATE app_users SET display_name = ? WHERE id = ?").run(body.displayName.trim(), userId);
      appendAudit(ctx.db, {
        action: "user.updated",
        actor,
        summary: `Zmieniono nazwę konta ${target.username}`,
        entityType: "app_user",
        entityId: userId,
      });
    }

    if (body.isActive === false) {
      ctx.db.prepare("UPDATE app_users SET is_active = 0 WHERE id = ?").run(userId);
      destroyAllUserSessions(ctx.db, userId);
      appendAudit(ctx.db, {
        action: "user.deactivated",
        actor,
        summary: `Wyłączono konto ${target.username}`,
        entityType: "app_user",
        entityId: userId,
      });
    } else if (body.isActive === true) {
      ctx.db.prepare("UPDATE app_users SET is_active = 1 WHERE id = ?").run(userId);
      appendAudit(ctx.db, {
        action: "user.updated",
        actor,
        summary: `Włączono konto ${target.username}`,
        entityType: "app_user",
        entityId: userId,
      });
    }

    if (body.resetPassword) {
      newPassword = generatePassword({ length: 16, maxDigits: 4 }).password;
      const hash = await hashPassword(newPassword);
      ctx.db.prepare("UPDATE app_users SET password_hash = ?, must_change_password = 1 WHERE id = ?").run(hash, userId);
      destroyAllUserSessions(ctx.db, userId);
      appendAudit(ctx.db, {
        action: "auth.password_changed",
        actor,
        summary: `Zresetowano hasło konta ${target.username}`,
        entityType: "app_user",
        entityId: userId,
      });
    }

    // Reset 2FA — ratunek dla osoby, która zgubiła telefon i kody odzyskiwania.
    // Własnego 2FA nie zdejmujemy tędy: admin musi użyć świadomego
    // DELETE /api/account/2fa, żeby nie odciąć sobie dostępu przez pomyłkę.
    if (body.resetTotp) {
      if (userId === ctx.user.id) {
        return NextResponse.json(
          {
            error: "Własne 2FA wyłączysz w „Moje konto” — tutaj nie zdejmiemy go przypadkiem",
            code: "self_totp",
          },
          { status: 400 },
        );
      }
      const tx = ctx.db.transaction(() => {
        ctx.db
          .prepare("UPDATE app_users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes_enc = NULL WHERE id = ?")
          .run(userId);
        // Usuwamy też wskaźniki wersji kluczy — bez tego zostałyby osierocone rekordy.
        ctx.db.prepare("DELETE FROM app_user_secrets WHERE user_id = ?").run(userId);
        appendAudit(ctx.db, {
          action: "auth.totp_reset",
          actor,
          summary: `Zresetowano 2FA konta ${target.username}`,
          entityType: "app_user",
          entityId: userId,
        });
      });
      tx();
      // Sesje unieważniamy: osoba bez drugiego składnika nie może korzystać
      // z sesji otwartej przed resetem.
      destroyAllUserSessions(ctx.db, userId);
    }

    return NextResponse.json({ ok: true, password: newPassword });
  } catch (error) {
    return handleApiError(error);
  }
}
