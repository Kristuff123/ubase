/** POST /api/account/2fa — włączenie 2FA; GET — status. DELETE — wyłączenie (tylko admin). */
import { NextResponse } from "next/server";
import { canAdmin, requireUser } from "@/lib/auth/context";
import { appendAudit } from "@/lib/audit/log";
import { enrollTotp } from "@/lib/auth/service";
import { otpauthUri } from "@/lib/crypto/totp";
import QRCode from "qrcode";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST() {
  try {
    const ctx = await requireUser({ write: true });
    const { secret, recoveryCodes } = enrollTotp(ctx.db, ctx.user.id, ctx.ip);
    const uri = otpauthUri(secret, ctx.user.username);
    const qrDataUrl = await QRCode.toDataURL(uri, { margin: 1, width: 240 });
    return NextResponse.json({ secret, uri, qrDataUrl, recoveryCodes });
  } catch (error) {
    return handleApiError(error);
  }
}

export async function DELETE() {
  try {
    const ctx = await requireUser({ write: true });
    if (!canAdmin(ctx.user.role)) {
      return NextResponse.json({ error: "Tylko administrator może wyłączyć 2FA", code: "forbidden" }, { status: 403 });
    }
    ctx.db
      .prepare("UPDATE app_users SET totp_enabled = 0, totp_secret_enc = NULL, recovery_codes_enc = NULL WHERE id = ?")
      .run(ctx.user.id);
    ctx.db.prepare("DELETE FROM app_user_secrets WHERE user_id = ?").run(ctx.user.id);
    appendAudit(ctx.db, {
      action: "auth.totp_enrolled",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: `Wyłączono 2FA: ${ctx.user.username}`,
      entityType: "app_user",
      entityId: ctx.user.id,
    });
    return NextResponse.json({ ok: true });
  } catch (error) {
    return handleApiError(error);
  }
}
