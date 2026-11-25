/**
 * Sesje: token w cookie HttpOnly, w bazie tylko SHA-256 tokenu.
 * Sesja „pending_2fa" istnieje po poprawnym haśle, ale przed kodem TOTP — nie daje dostępu.
 */
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import type { Db } from "@/db";

export const SESSION_COOKIE = "ub_session";
export const CSRF_COOKIE = "ub_csrf";
export const IDLE_TIMEOUT_MS = 30 * 60 * 1000;
export const ABSOLUTE_TIMEOUT_MS = 12 * 60 * 60 * 1000;
export const PENDING_2FA_TIMEOUT_MS = 5 * 60 * 1000;

export type SessionRecord = {
  id: string;
  user_id: number;
  token_hash: string;
  csrf_hash: string;
  created_at: number;
  last_seen_at: number;
  expires_at: number;
  ip: string | null;
  user_agent: string | null;
  pending_2fa: number;
  reauth_at: number | null;
};

/** Ile sekund ważne jest ponowne potwierdzenie hasła (bramka do sekretów). */
export const REAUTH_WINDOW_MS = 5 * 60 * 1000;

export function markReauthenticated(db: Db, sessionId: string): void {
  db.prepare("UPDATE sessions SET reauth_at = ? WHERE id = ?").run(Date.now(), sessionId);
}

/** Czy sesja ma świeże potwierdzenie hasła. */
export function hasFreshReauth(session: SessionRecord): boolean {
  return Boolean(session.reauth_at && Date.now() - session.reauth_at < REAUTH_WINDOW_MS);
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function createSession(
  db: Db,
  params: { userId: number; ip: string | null; userAgent: string | null; pending2fa?: boolean },
): { token: string; csrfToken: string; expiresAt: number } {
  const token = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(32).toString("base64url");
  const nowMs = Date.now();
  const expiresAt = nowMs + (params.pending2fa ? PENDING_2FA_TIMEOUT_MS : ABSOLUTE_TIMEOUT_MS);
  db.prepare(
    `INSERT INTO sessions (id, user_id, token_hash, csrf_hash, created_at, last_seen_at, expires_at, ip, user_agent, pending_2fa)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    randomBytes(16).toString("hex"),
    params.userId,
    hashToken(token),
    hashToken(csrfToken),
    nowMs,
    nowMs,
    expiresAt,
    params.ip,
    params.userAgent,
    params.pending2fa ? 1 : 0,
  );
  return { token, csrfToken, expiresAt };
}

/** Podnosi sesję pending_2fa do pełnej po poprawnym kodzie TOTP. */
export function promoteSession(db: Db, sessionId: string): void {
  const nowMs = Date.now();
  db.prepare("UPDATE sessions SET pending_2fa = 0, last_seen_at = ?, expires_at = ? WHERE id = ?").run(
    nowMs,
    nowMs + ABSOLUTE_TIMEOUT_MS,
    sessionId,
  );
}

export type SessionLookup =
  | { kind: "none" }
  | { kind: "expired" }
  | { kind: "pending"; session: SessionRecord }
  | { kind: "active"; session: SessionRecord };

export function lookupSession(db: Db, token: string | undefined): SessionLookup {
  if (!token) return { kind: "none" };
  const row = db.prepare("SELECT * FROM sessions WHERE token_hash = ?").get(hashToken(token)) as
    | SessionRecord
    | undefined;
  if (!row) return { kind: "none" };

  const nowMs = Date.now();
  if (row.expires_at <= nowMs) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return { kind: "expired" };
  }
  if (nowMs - row.last_seen_at > IDLE_TIMEOUT_MS && row.pending_2fa === 0) {
    db.prepare("DELETE FROM sessions WHERE id = ?").run(row.id);
    return { kind: "expired" };
  }
  if (row.pending_2fa === 1) return { kind: "pending", session: row };

  db.prepare("UPDATE sessions SET last_seen_at = ? WHERE id = ?").run(nowMs, row.id);
  return { kind: "active", session: row };
}

export function destroySession(db: Db, sessionId: string): void {
  db.prepare("DELETE FROM sessions WHERE id = ?").run(sessionId);
}

export function destroyAllUserSessions(db: Db, userId: number, exceptId?: string): void {
  if (exceptId) {
    db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").run(userId, exceptId);
  } else {
    db.prepare("DELETE FROM sessions WHERE user_id = ?").run(userId);
  }
}

export function verifyCsrf(session: SessionRecord, csrfToken: string | undefined): boolean {
  if (!csrfToken) return false;
  const provided = Buffer.from(hashToken(csrfToken));
  const expected = Buffer.from(session.csrf_hash);
  return provided.length === expected.length && timingSafeEqual(provided, expected);
}

export function purgeExpiredSessions(db: Db): number {
  const result = db.prepare("DELETE FROM sessions WHERE expires_at <= ?").run(Date.now());
  return result.changes;
}
