/**
 * Uwierzytelnianie: logowanie (hasło → 2FA), re-auth, bootstrap pierwszego konta.
 *
 * Przepływ logowania:
 * 1. hasło poprawne + konto bez 2FA → sesja pełna,
 * 2. hasło poprawne + 2FA → sesja pending_2fa, potem /api/auth/2fa,
 * 3. hasło błędne → licznik nieudanych prób, blokada po 5 na 15 min.
 */
import type { Db } from "@/db";
import { appendAudit, type AuditActor } from "@/lib/audit/log";
import { decryptWithKey, encryptWithKey, totpAad } from "@/lib/crypto/envelope";
import { hashPassword, verifyPassword } from "@/lib/crypto/password";
import { generateRecoveryCodes, generateTotpSecret, verifyTotp } from "@/lib/crypto/totp";
import { getActiveKey, keyForVersion } from "@/db/keys";
import { LIMITS, rateLimit, resetRateLimit } from "./rate-limit";
import { createSession, promoteSession, type SessionRecord } from "./session";

const MAX_FAILED = 5;
const LOCK_MS = 15 * 60 * 1000;

export type AppUserRow = {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "operator" | "audytor";
  password_hash: string;
  totp_secret_enc: string | null;
  totp_enabled: number;
  recovery_codes_enc: string | null;
  failed_attempts: number;
  locked_until: number | null;
  must_change_password: number;
  is_active: number;
  created_at: number;
  last_login_at: number | null;
};

export class AuthError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.code = code;
  }
}

export type LoginResult =
  | { kind: "active"; token: string; csrfToken: string; user: AppUserRow }
  | { kind: "pending_2fa"; token: string; csrfToken: string; user: AppUserRow };

function actorFor(user: AppUserRow, ip: string | null): AuditActor {
  return { userId: user.id, name: user.display_name, ip };
}

export async function login(
  db: Db,
  params: { username: string; password: string; ip: string | null; userAgent: string | null },
): Promise<LoginResult> {
  const ipKey = `login:ip:${params.ip ?? "unknown"}`;
  const ipLimit = rateLimit(ipKey, LIMITS.login.limit, LIMITS.login.windowMs);
  if (!ipLimit.allowed) {
    throw new AuthError("rate_limited", `Zbyt wiele prób. Spróbuj ponownie za ${ipLimit.retryAfterSeconds} s.`);
  }

  const accountKey = `login:user:${params.username.toLowerCase()}`;
  const accountLimit = rateLimit(accountKey, LIMITS.loginPerAccount.limit, LIMITS.loginPerAccount.windowMs);
  if (!accountLimit.allowed) {
    throw new AuthError("rate_limited", "Zbyt wiele prób dla tego konta. Spróbuj później.");
  }

  const user = db.prepare("SELECT * FROM app_users WHERE username = ? COLLATE NOCASE").get(params.username) as
    | AppUserRow
    | undefined;

  const genericFailure = () => new AuthError("invalid_credentials", "Nieprawidłowy login lub hasło");

  if (!user || !user.is_active) {
    if (user) {
      appendAudit(db, {
        action: "auth.login_failed",
        actor: { userId: null, name: params.username, ip: params.ip },
        summary: `Nieudane logowanie (konto nieaktywne): ${params.username}`,
        entityType: "app_user",
        entityId: user.id,
      });
    } else {
      appendAudit(db, {
        action: "auth.login_failed",
        actor: { userId: null, name: params.username, ip: params.ip },
        summary: `Nieudane logowanie (nieznane konto): ${params.username}`,
      });
    }
    // Hash i tak liczymy, żeby nie ujawniać istnienia konta czasem odpowiedzi.
    await verifyPassword("$argon2id$v=19$m=65536,t=3,p=1$c2FsdHNhbHQ$0000000000000000000000000000000000000000000", params.password);
    throw genericFailure();
  }

  if (user.locked_until && user.locked_until > Date.now()) {
    const seconds = Math.ceil((user.locked_until - Date.now()) / 1000);
    throw new AuthError("locked", `Konto zablokowane. Spróbuj ponownie za ${seconds} s.`);
  }

  const ok = await verifyPassword(user.password_hash, params.password);
  if (!ok) {
    const failed = user.failed_attempts + 1;
    const lockedUntil = failed >= MAX_FAILED ? Date.now() + LOCK_MS : null;
    db.prepare("UPDATE app_users SET failed_attempts = ?, locked_until = ? WHERE id = ?").run(
      lockedUntil ? 0 : failed,
      lockedUntil,
      user.id,
    );
    appendAudit(db, {
      action: lockedUntil ? "auth.lockout" : "auth.login_failed",
      actor: { userId: null, name: user.username, ip: params.ip },
      summary: lockedUntil
        ? `Konto zablokowane po ${MAX_FAILED} nieudanych próbach: ${user.username}`
        : `Nieudane logowanie: ${user.username}`,
      entityType: "app_user",
      entityId: user.id,
      details: { failedAttempts: failed },
    });
    if (lockedUntil) throw new AuthError("locked", `Konto zablokowane na ${LOCK_MS / 60000} min.`);
    throw genericFailure();
  }

  // Sukces hasła: reset licznika prób.
  db.prepare("UPDATE app_users SET failed_attempts = 0, locked_until = NULL WHERE id = ?").run(user.id);
  resetRateLimit(accountKey);

  const needs2fa = user.totp_enabled === 1;
  const session = createSession(db, {
    userId: user.id,
    ip: params.ip,
    userAgent: params.userAgent,
    pending2fa: needs2fa,
  });

  appendAudit(db, {
    action: "auth.login",
    actor: actorFor(user, params.ip),
    summary: needs2fa ? `Hasło poprawne, oczekiwanie na 2FA: ${user.username}` : `Zalogowano: ${user.username}`,
    entityType: "app_user",
    entityId: user.id,
    details: { pending2fa: needs2fa },
  });

  if (!needs2fa) {
    db.prepare("UPDATE app_users SET last_login_at = ? WHERE id = ?").run(Date.now(), user.id);
    return { kind: "active", token: session.token, csrfToken: session.csrfToken, user };
  }
  return { kind: "pending_2fa", token: session.token, csrfToken: session.csrfToken, user };
}

/** Drugi krok logowania: kod TOTP albo kod odzyskiwania. */
export function completeTwoFactor(
  db: Db,
  params: { session: SessionRecord; user: AppUserRow; code: string; ip: string | null },
): void {
  const limit = rateLimit(`totp:${params.user.id}`, LIMITS.totp.limit, LIMITS.totp.windowMs);
  if (!limit.allowed) {
    throw new AuthError("rate_limited", "Zbyt wiele prób kodu. Spróbuj później.");
  }

  const normalized = params.code.trim().toUpperCase();
  let ok = false;
  let usedRecovery = false;

  if (/^\d{6}$/.test(normalized) && params.user.totp_secret_enc) {
    const kek = keyForVersion(db, readKeyVersion(db, params.user.id, "totp"));
    const secret = decryptWithKey(params.user.totp_secret_enc, kek, totpAad(params.user.id));
    ok = verifyTotp(secret, normalized);
  } else if (normalized.includes("-") || /^[A-Z0-9]{8}$/.test(normalized)) {
    const result = consumeRecoveryCode(db, params.user, normalized.replace(/-/g, ""));
    ok = result;
    usedRecovery = result;
  }

  if (!ok) {
    appendAudit(db, {
      action: "auth.2fa_failed",
      actor: { userId: params.user.id, name: params.user.display_name, ip: params.ip },
      summary: `Nieprawidłowy kod 2FA: ${params.user.username}`,
      entityType: "app_user",
      entityId: params.user.id,
    });
    throw new AuthError("invalid_code", "Nieprawidłowy kod");
  }

  promoteSession(db, params.session.id);
  db.prepare("UPDATE app_users SET last_login_at = ? WHERE id = ?").run(Date.now(), params.user.id);
  appendAudit(db, {
    action: "auth.2fa",
    actor: { userId: params.user.id, name: params.user.display_name, ip: params.ip },
    summary: `2FA potwierdzone${usedRecovery ? " (kod odzyskiwania)" : ""}: ${params.user.username}`,
    entityType: "app_user",
    entityId: params.user.id,
  });
}

function readKeyVersion(db: Db, userId: number, kind: "totp" | "recovery"): number {
  const row = db.prepare("SELECT key_version FROM app_user_secrets WHERE user_id = ? AND kind = ?").get(userId, kind) as
    | { key_version: number }
    | undefined;
  if (row) return row.key_version;
  return getActiveKey(db).version;
}

function consumeRecoveryCode(db: Db, user: AppUserRow, code: string): boolean {
  if (!user.recovery_codes_enc) return false;
  const kek = keyForVersion(db, readKeyVersion(db, user.id, "recovery"));
  const raw = decryptWithKey(user.recovery_codes_enc, kek, `app_user:${user.id}:recovery`);
  const codes: string[] = JSON.parse(raw);
  // Kody generujemy małymi literami, ale użytkownik może je wpisać wielkimi —
  // porównujemy bez rozróżniania wielkości i bez myślników.
  const wanted = normalizeRecoveryCode(code);
  const idx = codes.findIndex((c) => normalizeRecoveryCode(c) === wanted);
  if (idx === -1) return false;
  const remaining = [...codes.slice(0, idx), ...codes.slice(idx + 1)];
  db.prepare("UPDATE app_users SET recovery_codes_enc = ? WHERE id = ?").run(
    encryptWithKey(JSON.stringify(remaining), kek, `app_user:${user.id}:recovery`),
    user.id,
  );
  return true;
}

function normalizeRecoveryCode(code: string): string {
  return code.replace(/-/g, "").trim().toLowerCase();
}

/** Włączenie 2FA: generuje sekret i kody odzyskiwania (zwracane raz). */
export function enrollTotp(
  db: Db,
  userId: number,
  ip: string | null,
): { secret: string; recoveryCodes: string[] } {
  const user = db.prepare("SELECT * FROM app_users WHERE id = ?").get(userId) as AppUserRow;
  const { dek, version } = getActiveKey(db);
  const secret = generateTotpSecret();
  const codes = generateRecoveryCodes();
  const tx = db.transaction(() => {
    db.prepare(
      `INSERT INTO app_user_secrets (user_id, kind, key_version) VALUES (?, 'totp', ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET key_version = excluded.key_version`,
    ).run(userId, version);
    db.prepare(
      `INSERT INTO app_user_secrets (user_id, kind, key_version) VALUES (?, 'recovery', ?)
       ON CONFLICT(user_id, kind) DO UPDATE SET key_version = excluded.key_version`,
    ).run(userId, version);
    db.prepare("UPDATE app_users SET totp_secret_enc = ?, recovery_codes_enc = ?, totp_enabled = 1 WHERE id = ?").run(
      encryptWithKey(secret, dek, totpAad(userId)),
      encryptWithKey(JSON.stringify(codes), dek, `app_user:${userId}:recovery`),
      userId,
    );
    appendAudit(db, {
      action: "auth.totp_enrolled",
      actor: { userId, name: user.display_name, ip },
      summary: `Włączono 2FA: ${user.username}`,
      entityType: "app_user",
      entityId: userId,
    });
  });
  tx();
  return { secret, recoveryCodes: codes };
}

/** Bootstrap: pierwsze konto admina, jeśli brak jakichkolwiek kont. */
export async function bootstrapAdmin(db: Db, generatedPassword: string): Promise<boolean> {
  const count = (db.prepare("SELECT COUNT(*) AS c FROM app_users").get() as { c: number }).c;
  if (count > 0) return false;
  const hash = await hashPassword(generatedPassword);
  db.prepare(
    `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
     VALUES (?, ?, 'admin', ?, 1, ?)`,
  ).run("admin", "Administrator", hash, Date.now());
  appendAudit(db, {
    action: "user.created",
    actor: { userId: null, name: "system", ip: null },
    summary: "Utworzono konto startowe admin (wymuszona zmiana hasła)",
    entityType: "app_user",
    entityId: 1,
  });
  return true;
}

/** Re-auth: ponowne potwierdzenie hasła dla operacji wrażliwych. */
export async function reauthenticate(
  db: Db,
  params: { user: AppUserRow; password: string; ip: string | null },
): Promise<boolean> {
  const limit = rateLimit(`reauth:${params.user.id}`, 10, 5 * 60 * 1000);
  if (!limit.allowed) throw new AuthError("rate_limited", "Zbyt wiele prób potwierdzenia hasła.");
  const ok = await verifyPassword(params.user.password_hash, params.password);
  appendAudit(db, {
    action: ok ? "auth.reauth" : "auth.reauth_failed",
    actor: actorFor(params.user, params.ip),
    summary: ok
      ? `Potwierdzono hasło: ${params.user.username}`
      : `Nieudane potwierdzenie hasła: ${params.user.username}`,
    entityType: "app_user",
    entityId: params.user.id,
  });
  return ok;
}
