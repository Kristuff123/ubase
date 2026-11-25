/**
 * Harness testów integracyjnych API.
 *
 * Zasada: podmieniamy TYLKO granicę frameworku — `cookies()`/`headers()` z `next/headers`
 * oraz `getDb()` z `@/db`. Cały łańcuch bezpieczeństwa (hash tokenu, lookup sesji, rola,
 * CSRF, reauth) wykonuje się naprawdę, więc test wykryje regresję w logice uprawnień,
 * a nie tylko w mocku.
 */
import { createHash } from "node:crypto";
import { vi } from "vitest";
import type { Db } from "@/db";
import { createTestDb } from "@/db";
import { hashPassword } from "@/lib/crypto/password";
import { clearRateLimits } from "@/lib/auth/rate-limit";
import { createSession, CSRF_COOKIE, SESSION_COOKIE } from "@/lib/auth/session";

const holder = vi.hoisted(() => ({
  db: undefined as unknown as Db,
  cookies: new Map<string, string>(),
  headers: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) => {
      const value = holder.cookies.get(name);
      return value === undefined ? undefined : { name, value };
    },
    getAll: () => [...holder.cookies].map(([name, value]) => ({ name, value })),
    has: (name: string) => holder.cookies.has(name),
    set: (name: string, value: string) => void holder.cookies.set(name, value),
    delete: (name: string) => void holder.cookies.delete(name),
  }),
  headers: async () => {
    const lower = new Map([...holder.headers].map(([k, v]) => [k.toLowerCase(), v]));
    return {
      get: (name: string) => lower.get(name.toLowerCase()) ?? null,
      has: (name: string) => lower.has(name.toLowerCase()),
      entries: () => lower.entries(),
      forEach: (cb: (value: string, key: string) => void) => lower.forEach(cb),
      [Symbol.iterator]: () => lower.entries(),
    };
  },
}));

// Handlery wołają getDb() — kierujemy je na bazę testową.
vi.mock("@/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/db")>();
  return { ...actual, getDb: () => holder.db };
});

export type TestUser = {
  id: number;
  username: string;
  role: "admin" | "operator" | "audytor";
  password: string;
};

export function resetRequestState(): void {
  holder.cookies.clear();
  holder.headers.clear();
  clearRateLimits();
}

/** Świeża baza w pamięci, ustawiona jako baza aplikacji. */
export function makeDb(): Db {
  const db = createTestDb();
  holder.db = db;
  resetRequestState();
  return db;
}

/** Tworzy konto w bazie z prawdziwym hashem Argon2id. */
export async function seedUser(
  db: Db,
  params: { username: string; role: TestUser["role"]; displayName?: string; password?: string },
): Promise<TestUser> {
  const password = params.password ?? "TestoweHaslo123";
  const hash = await hashPassword(password);
  const id = db
    .prepare(
      `INSERT INTO app_users (username, display_name, role, password_hash, must_change_password, created_at)
       VALUES (?, ?, ?, ?, 0, ?)`,
    )
    .run(params.username, params.displayName ?? params.username, params.role, hash, Date.now())
    .lastInsertRowid as number;
  return { id, username: params.username, role: params.role, password };
}

/**
 * Ustawia aktywną sesję dla użytkownika — dokładnie tak, jak po udanym logowaniu.
 * Zwraca tokeny, żeby test mógł sprawdzić zachowanie przy braku/złym CSRF.
 */
export function actAs(
  db: Db,
  user: { id: number },
  options: { reauth?: boolean; pending2fa?: boolean; csrf?: string | null } = {},
): { token: string; csrfToken: string } {
  const { token, csrfToken } = createSession(db, {
    userId: user.id,
    ip: "10.0.0.1",
    userAgent: "vitest",
    pending2fa: options.pending2fa,
  });
  holder.cookies.set(SESSION_COOKIE, token);
  holder.cookies.set(CSRF_COOKIE, csrfToken);
  if (options.csrf !== null) holder.headers.set("x-csrf-token", options.csrf ?? csrfToken);
  holder.headers.set("x-forwarded-for", "203.0.113.9, 10.0.0.1");
  if (options.reauth) {
    const tokenHash = createHash("sha256").update(token).digest("hex");
    db.prepare("UPDATE sessions SET reauth_at = ? WHERE token_hash = ?").run(Date.now(), tokenHash);
  }
  return { token, csrfToken };
}

export function actAsAnonymous(): void {
  resetRequestState();
}

/** Ustawia wyłącznie cookie sesji (np. gdy token pochodzi z odpowiedzi logowania). */
export function setSessionCookie(token: string): void {
  holder.cookies.set(SESSION_COOKIE, token);
}

export function dropCsrfHeader(): void {
  holder.headers.delete("x-csrf-token");
}

export function setCsrfHeader(value: string): void {
  holder.headers.set("x-csrf-token", value);
}

/** Buduje `Request` z JSON-em i nagłówkiem CSRF z bieżącego stanu. */
export function jsonRequest(
  url: string,
  init: { method?: string; body?: unknown; csrf?: string | null } = {},
): Request {
  const headers = new Headers({ "content-type": "application/json" });
  const csrf = init.csrf === undefined ? holder.headers.get("x-csrf-token") : (init.csrf ?? undefined);
  if (csrf) headers.set("x-csrf-token", csrf);
  return new Request(url, {
    method: init.method ?? "POST",
    headers,
    body: init.body === undefined ? undefined : JSON.stringify(init.body),
  });
}

export function getRequest(url: string): Request {
  return new Request(url, { method: "GET" });
}

/** Odczyt JSON z odpowiedzi (z sensownym komunikatem przy błędzie). */
export async function readJsonBody<T = Record<string, unknown>>(response: Response): Promise<T> {
  const text = await response.text();
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error(`Odpowiedź nie jest JSON-em (status ${response.status}): ${text.slice(0, 200)}`);
  }
}
