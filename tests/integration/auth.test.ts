/**
 * Przepływ uwierzytelniania: logowanie, 2FA, wygasanie sesji, blokada konta.
 *
 * Testujemy przez prawdziwe route handlery, z prawdziwym Argon2id i prawdziwym TOTP.
 * Dzięki temu wykrywamy regresje w całym łańcuchu, nie tylko w pojedynczej funkcji.
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { enrollTotp } from "@/lib/auth/service";
import { totpAt } from "@/lib/crypto/totp";
import { ABSOLUTE_TIMEOUT_MS, IDLE_TIMEOUT_MS, SESSION_COOKIE, createSession } from "@/lib/auth/session";
import { clearRateLimits } from "@/lib/auth/rate-limit";
import { createHash } from "node:crypto";
import { actAs, actAsAnonymous, dropCsrfHeader, jsonRequest, makeDb, readJsonBody, seedUser, type TestUser } from "./harness";

import * as loginRoute from "@/app/api/auth/login/route";
import * as twoFactorRoute from "@/app/api/auth/2fa/route";
import * as logoutRoute from "@/app/api/auth/logout/route";
import * as meRoute from "@/app/api/auth/me/route";
import * as reauthRoute from "@/app/api/auth/reauth/route";
import * as workersRoute from "@/app/api/workers/route";

let db: Db;
const PASSWORD = "BardzoDlugieHaslo1";

async function user(overrides: Partial<Parameters<typeof seedUser>[1]> = {}): Promise<TestUser> {
  return seedUser(db, {
    username: "jkowalski",
    role: "operator",
    displayName: "Jan Kowalski",
    password: PASSWORD,
    ...overrides,
  });
}

function loginRequest(username: string, password: string) {
  return new Request("http://x/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "x-forwarded-for": "198.51.100.7" },
    body: JSON.stringify({ username, password }),
  });
}

beforeEach(() => {
  db = makeDb();
});

describe("logowanie", () => {
  it("poprawne dane zwracają sesję aktywną i ustawiają cookies", async () => {
    const u = await user();
    const res = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ status: string; user: { role: string } }>(res);
    expect(body.status).toBe("active");
    expect(body.user.role).toBe("operator");

    const cookies = res.headers.getSetCookie();
    const sessionCookie = cookies.find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    expect(sessionCookie).toBeDefined();
    expect(sessionCookie).toContain("HttpOnly");
    expect(sessionCookie).toContain("SameSite=lax");
    // Cookie CSRF musi być czytelne dla JS (double-submit), ale nie może być HttpOnly.
    const csrfCookie = cookies.find((c) => c.startsWith("ub_csrf="))!;
    expect(csrfCookie).toBeDefined();
    expect(csrfCookie).not.toContain("HttpOnly");
  });

  it("błędne hasło nie ujawnia, czy login istnieje", async () => {
    const u = await user();
    const wrongPassword = await loginRoute.POST(loginRequest(u.username, "ZleHaslo12345"));
    const noSuchUser = await loginRoute.POST(loginRequest("nietaki", "ZleHaslo12345"));
    expect(wrongPassword.status).toBe(401);
    expect(noSuchUser.status).toBe(401);
    const a = await readJsonBody(wrongPassword);
    const b = await readJsonBody(noSuchUser);
    expect(a.error).toBe(b.error);
  });

  it("wyłączone konto nie może się zalogować", async () => {
    const u = await user();
    db.prepare("UPDATE app_users SET is_active = 0 WHERE id = ?").run(u.id);
    const res = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    expect(res.status).toBe(401);
  });

  it("konto z 2FA dostaje sesję pending, nie pełną", async () => {
    const u = await user();
    enrollTotp(db, u.id, null);
    const res = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ status: string }>(res);
    expect(body.status).toBe("pending_2fa");

    // Sesja pending nie daje dostępu do danych.
    const cookie = res.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const token = cookie.split(";")[0].split("=")[1];
    await applySessionToken(token);
    const denied = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(denied.status).toBe(401);
  });

  it("blokuje konto po 5 nieudanych próbach", async () => {
    const u = await user();
    for (let i = 0; i < 5; i += 1) {
      await loginRoute.POST(loginRequest(u.username, "ZleHaslo12345"));
    }
    const row = db.prepare("SELECT failed_attempts, locked_until FROM app_users WHERE id = ?").get(u.id) as {
      failed_attempts: number;
      locked_until: number | null;
    };
    // Po przekroczeniu progu licznik jest zerowany, a konto dostaje blokadę czasową.
    expect(row.locked_until).toBeGreaterThan(Date.now());

    // Rate limiter (5 prób/15 min) też już zadziałał — czyścimy go, żeby sprawdzić samą blokadę konta.
    clearRateLimits();
    const res = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    // Blokada konta zwraca 429 (ta sama semantyka co rate limit: „spróbuj później”).
    expect(res.status).toBe(429);
    expect((await readJsonBody(res)).code).toBe("locked");
  });

  it("udane logowanie zeruje licznik nieudanych prób", async () => {
    const u = await user();
    await loginRoute.POST(loginRequest(u.username, "ZleHaslo12345"));
    await loginRoute.POST(loginRequest(u.username, PASSWORD));
    const row = db.prepare("SELECT failed_attempts FROM app_users WHERE id = ?").get(u.id) as {
      failed_attempts: number;
    };
    expect(row.failed_attempts).toBe(0);
  });

  it("brak hasła lub loginu zwraca 400", async () => {
    const res = await loginRoute.POST(
      new Request("http://x/api/auth/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "x" }),
      }),
    );
    expect(res.status).toBe(400);
  });
});

describe("2FA", () => {
  it("poprawny kod TOTP promuje sesję do pełnej", async () => {
    const u = await user();
    const { secret } = enrollTotp(db, u.id, null);
    const loginRes = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    const cookie = loginRes.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`))!;
    const token = cookie.split(";")[0].split("=")[1];
    await applySessionToken(token);

    const code = totpAt(secret, Math.floor(Date.now() / 1000));
    const res = await twoFactorRoute.POST(
      new Request("http://x/api/auth/2fa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code }),
      }),
    );
    expect(res.status).toBe(200);
    expect((await readJsonBody(res)).status).toBe("active");

    const allowed = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(allowed.status).toBe(200);
  });

  it("błędny kod TOTP jest odrzucany", async () => {
    const u = await user();
    enrollTotp(db, u.id, null);
    const loginRes = await loginRoute.POST(loginRequest(u.username, PASSWORD));
    await applySessionToken(sessionTokenFrom(loginRes));

    const res = await twoFactorRoute.POST(
      new Request("http://x/api/auth/2fa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "000000" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await readJsonBody(res)).code).toBe("invalid_code");
  });

  it("kod odzyskiwania działa tylko raz", async () => {
    const u = await user();
    const { recoveryCodes } = enrollTotp(db, u.id, null);
    const code = recoveryCodes[0];

    for (const attempt of [1, 2]) {
      const loginRes = await loginRoute.POST(loginRequest(u.username, PASSWORD));
      await applySessionToken(sessionTokenFrom(loginRes));
      const res = await twoFactorRoute.POST(
        new Request("http://x/api/auth/2fa", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ code }),
        }),
      );
      if (attempt === 1) expect(res.status).toBe(200);
      else expect(res.status).toBe(401);
    }
  });

  it("2FA bez sesji pending zwraca 401", async () => {
    actAsAnonymous();
    const res = await twoFactorRoute.POST(
      new Request("http://x/api/auth/2fa", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ code: "123456" }),
      }),
    );
    expect(res.status).toBe(401);
    expect((await readJsonBody(res)).code).toBe("no_pending");
  });
});

describe("sesje", () => {
  it("sesja wygasa po bezczynności", async () => {
    const u = await user();
    const { token } = createSession(db, { userId: u.id, ip: "1.1.1.1", userAgent: "t" });
    await applySessionToken(token);
    // Symulujemy 31 minut bezczynności.
    db.prepare("UPDATE sessions SET last_seen_at = ?").run(Date.now() - IDLE_TIMEOUT_MS - 60_000);
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(401);
  });

  it("sesja wygasa po 12 h niezależnie od aktywności", async () => {
    const u = await user();
    const { token } = createSession(db, { userId: u.id, ip: "1.1.1.1", userAgent: "t" });
    await applySessionToken(token);
    db.prepare("UPDATE sessions SET expires_at = ?, last_seen_at = ?").run(
      Date.now() - 1000,
      Date.now(),
    );
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(401);
    expect(ABSOLUTE_TIMEOUT_MS).toBe(12 * 60 * 60 * 1000);
  });

  it("wylogowanie unieważnia sesję w bazie", async () => {
    const u = await user();
    actAs(db, u);
    const res = await logoutRoute.POST(
      new Request("http://x/api/auth/logout", { method: "POST", headers: { "x-forwarded-for": "1.1.1.1" } }),
    );
    expect(res.status).toBe(200);
    const count = db.prepare("SELECT COUNT(*) AS c FROM sessions WHERE user_id = ?").get(u.id) as { c: number };
    expect(count.c).toBe(0);
  });

  it("dezaktywacja konta unieważnia istniejące sesje przy następnym żądaniu", async () => {
    const u = await user();
    actAs(db, u);
    db.prepare("UPDATE app_users SET is_active = 0 WHERE id = ?").run(u.id);
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(401);
    expect((await readJsonBody(res)).code).toBe("inactive");
  });

  it("token sesji nie jest przechowywany w bazie jawnie", async () => {
    const u = await user();
    const { token } = createSession(db, { userId: u.id, ip: "1.1.1.1", userAgent: "t" });
    const rows = db.prepare("SELECT token_hash, csrf_hash FROM sessions").all() as {
      token_hash: string;
      csrf_hash: string;
    }[];
    for (const row of rows) {
      expect(row.token_hash).not.toBe(token);
      expect(row.token_hash).toHaveLength(64); // SHA-256 hex
    }
  });
});

describe("/api/auth/me", () => {
  it("zwraca dane zalogowanego użytkownika bez hasha hasła", async () => {
    const u = await user();
    actAs(db, u);
    const res = await meRoute.GET();
    expect(res.status).toBe(200);
    const text = await res.text();
    expect(text).not.toContain("$argon2");
    const body = JSON.parse(text) as { user: { username: string; role: string } };
    expect(body.user.username).toBe(u.username);
    expect(body.user.role).toBe("operator");
  });
});

describe("ponowne potwierdzenie hasła (/api/auth/reauth)", () => {
  it("poprawne hasło ustawia reauth_at w sesji", async () => {
    const u = await user();
    const { csrfToken } = actAs(db, u);
    const res = await reauthRoute.POST(
      jsonRequest("http://x/api/auth/reauth", { body: { password: PASSWORD }, csrf: csrfToken }),
    );
    expect(res.status).toBe(200);
    const row = db.prepare("SELECT reauth_at FROM sessions WHERE user_id = ?").get(u.id) as {
      reauth_at: number | null;
    };
    expect(row.reauth_at).toBeGreaterThan(Date.now() - 5000);
  });

  it("błędne hasło nie ustawia reauth_at i jest logowane", async () => {
    const u = await user();
    actAs(db, u);
    const res = await reauthRoute.POST(
      jsonRequest("http://x/api/auth/reauth", { body: { password: "ZleHaslo12345" } }),
    );
    expect(res.status).toBe(401);
    const row = db.prepare("SELECT reauth_at FROM sessions WHERE user_id = ?").get(u.id) as {
      reauth_at: number | null;
    };
    expect(row.reauth_at).toBeNull();
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE action = 'auth.reauth_failed'").get() as {
      c: number;
    };
    expect(audit.c).toBe(1);
  });

  it("reauth wymaga CSRF", async () => {
    const u = await user();
    actAs(db, u);
    dropCsrfHeader();
    const res = await reauthRoute.POST(
      jsonRequest("http://x/api/auth/reauth", { body: { password: PASSWORD } }),
    );
    expect(res.status).toBe(403);
  });
});

/** Ustawia cookie sesji w holderze harnessu (omijając tworzenie nowej sesji). */
async function applySessionToken(token: string): Promise<void> {
  const mod = await import("./harness");
  mod.setSessionCookie(token);
}

/** Wyciąga wartość cookie sesji z odpowiedzi logowania. */
function sessionTokenFrom(response: Response): string {
  const cookie = response.headers.getSetCookie().find((c) => c.startsWith(`${SESSION_COOKIE}=`));
  if (!cookie) throw new Error("Odpowiedź nie ustawiła cookie sesji");
  return cookie.split(";")[0].slice(`${SESSION_COOKIE}=`.length);
}

describe("brak wycieku danych uwierzytelniających w audycie", () => {
  it("log audytu nie zawiera hasła ani tokenu sesji", async () => {
    const u = await user();
    await loginRoute.POST(loginRequest(u.username, PASSWORD));
    await loginRoute.POST(loginRequest(u.username, "ZleHaslo12345"));
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    expect(dump).not.toContain(PASSWORD);
    expect(dump).not.toContain("ZleHaslo12345");
  });

  it("log audytu nie zawiera hasha hasła", async () => {
    const u = await user();
    await loginRoute.POST(loginRequest(u.username, PASSWORD));
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    expect(dump).not.toContain("$argon2");
  });

  it("hash tokenu nie trafia do audytu", async () => {
    const u = await user();
    const { token } = createSession(db, { userId: u.id, ip: "1.1.1.1", userAgent: "t" });
    const tokenHash = createHash("sha256").update(token).digest("hex");
    const dump = JSON.stringify(db.prepare("SELECT * FROM audit_events").all());
    expect(dump).not.toContain(token);
    expect(dump).not.toContain(tokenHash);
  });
});
