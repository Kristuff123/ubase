/**
 * Kontekst żądania: użytkownik zalogowany, rola, adres IP.
 * Wszystkie endpointy API korzystają z tych helperów, żeby nie powielać logiki uprawnień.
 */
import { cookies, headers } from "next/headers";
import type { Db } from "@/db";
import { getDb } from "@/db";
import {
  SESSION_COOKIE,
  lookupSession,
  type SessionRecord,
} from "./session";

export type Role = "admin" | "operator" | "audytor";

export type AppUser = {
  id: number;
  username: string;
  display_name: string;
  role: Role;
  totp_enabled: number;
  must_change_password: number;
  is_active: number;
};

export type RequestContext = {
  db: Db;
  user: AppUser;
  session: SessionRecord;
  ip: string | null;
};

export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, message: string, code = "error") {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export function clientIpFromHeaders(h: Headers): string | null {
  const forwarded = h.get("x-forwarded-for");
  if (forwarded) {
    const parts = forwarded.split(",").map((p) => p.trim()).filter(Boolean);
    // Ostatni wpis pochodzi od zaufanego proxy (Caddy) — nie pierwszy.
    return parts.length ? parts[parts.length - 1] : null;
  }
  return h.get("x-real-ip");
}

export async function readClientIp(): Promise<string | null> {
  return clientIpFromHeaders(await headers());
}

/**
 * Wymaga zalogowanej sesji. `write=true` dodatkowo weryfikuje CSRF (nagłówek X-CSRF-Token).
 */
export async function requireUser(options: { write?: boolean; roles?: Role[] } = {}): Promise<RequestContext> {
  const cookieStore = await cookies();
  const token = cookieStore.get(SESSION_COOKIE)?.value;
  const db = getDb();
  const found = lookupSession(db, token);
  if (found.kind === "none" || found.kind === "expired") {
    throw new HttpError(401, "Brak zalogowania", "unauthenticated");
  }
  if (found.kind === "pending") {
    throw new HttpError(401, "Dokończ logowanie dwuetapowe", "pending_2fa");
  }

  const user = db
    .prepare("SELECT id, username, display_name, role, totp_enabled, must_change_password, is_active FROM app_users WHERE id = ?")
    .get(found.session.user_id) as AppUser | undefined;
  if (!user || !user.is_active) {
    throw new HttpError(401, "Konto nieaktywne", "inactive");
  }

  if (options.write) {
    const headerStore = await headers();
    const csrf = headerStore.get("x-csrf-token") ?? undefined;
    const { verifyCsrf } = await import("./session");
    if (!verifyCsrf(found.session, csrf)) {
      throw new HttpError(403, "Nieprawidłowy token CSRF", "csrf");
    }
  }

  if (options.roles && !options.roles.includes(user.role)) {
    throw new HttpError(403, "Brak uprawnień do tej operacji", "forbidden");
  }

  return {
    db,
    user,
    session: found.session,
    ip: await readClientIp(),
  };
}

/** Czy rola może edytować dane (pracownicy, dostępy). */
export function canEdit(role: Role): boolean {
  return role === "admin" || role === "operator";
}

/** Czy rola może widzieć sekrety w cleartext. */
export function canReveal(role: Role): boolean {
  return role === "admin" || role === "operator";
}

export function canAdmin(role: Role): boolean {
  return role === "admin";
}

export function requireEdit(ctx: RequestContext): void {
  if (!canEdit(ctx.user.role)) throw new HttpError(403, "Rola nie pozwala na edycję", "forbidden");
}
