/**
 * Uprawnienia ról i bramki bezpieczeństwa na poziomie API.
 *
 * Te testy odpowiadają na pytania, które realnie zada audytor:
 *  - czy audytor naprawdę nie może nic zmienić?
 *  - czy sekret da się podejrzeć bez ponownego potwierdzenia hasła?
 *  - czy żądanie spoza aplikacji (bez CSRF) zostanie odrzucone?
 *  - czy w odpowiedziach API nie wycieka plaintext sekretów?
 */
import { beforeEach, describe, expect, it } from "vitest";
import type { Db } from "@/db";
import { addAccess, createWorker, getWorkerDetail } from "@/lib/domain/workers";
import { createOrgUnit, getCategoryBySlug } from "@/lib/domain/org";
import {
  actAs,
  actAsAnonymous,
  dropCsrfHeader,
  jsonRequest,
  makeDb,
  readJsonBody,
  seedUser,
  setCsrfHeader,
  type TestUser,
} from "./harness";

import * as workersRoute from "@/app/api/workers/route";
import * as workerRoute from "@/app/api/workers/[id]/route";
import * as workerActionRoute from "@/app/api/workers/[id]/[action]/route";
import * as accessesRoute from "@/app/api/workers/[id]/accesses/route";
import * as revealRoute from "@/app/api/accesses/[id]/reveal/route";
import * as accessRoute from "@/app/api/accesses/[id]/route";
import * as auditRoute from "@/app/api/audit/route";
import * as auditVerifyRoute from "@/app/api/audit/verify/route";
import * as adminUsersRoute from "@/app/api/admin/users/route";
import * as adminUserRoute from "@/app/api/admin/users/[id]/route";
import * as exportRoute from "@/app/api/workers/[id]/export/route";

const actor = { userId: null, name: "seed", ip: null };

let db: Db;
let admin: TestUser;
let operator: TestUser;
let audytor: TestUser;
let workerId: number;
let accessId: number;
let sklepId: number;

const SECRET = "SuperTajneHasloXYZ";

async function seedWorld() {
  db = makeDb();
  admin = await seedUser(db, { username: "admin1", role: "admin", displayName: "Ala Admin" });
  operator = await seedUser(db, { username: "oper1", role: "operator", displayName: "Olek Operator" });
  audytor = await seedUser(db, { username: "audyt1", role: "audytor", displayName: "Ada Audytor" });

  sklepId = createOrgUnit(db, { type: "sklep", name: "Bytów Kaufland", actor }).id;
  const worker = createWorker(db, { firstName: "Jan", lastName: "Kowalski", orgUnitId: sklepId }, actor);
  workerId = worker.id;
  accessId = addAccess(
    db,
    workerId,
    { categoryId: getCategoryBySlug(db, "axel")!.id, values: { login: "jkowalski", password: SECRET } },
    actor,
  );
}

beforeEach(async () => {
  await seedWorld();
});

describe("dostęp bez uwierzytelnienia", () => {
  it("GET /api/workers zwraca 401 bez sesji", async () => {
    actAsAnonymous();
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(401);
    expect((await readJsonBody(res)).code).toBe("unauthenticated");
  });

  it("GET /api/workers/:id zwraca 401 bez sesji", async () => {
    actAsAnonymous();
    const res = await workerRoute.GET(new Request("http://x/api/workers/1"), { params: Promise.resolve({ id: "1" }) });
    expect(res.status).toBe(401);
  });

  it("sesja pending_2fa nie daje dostępu do danych", async () => {
    actAs(db, operator, { pending2fa: true });
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(401);
    expect((await readJsonBody(res)).code).toBe("pending_2fa");
  });
});

describe("CSRF", () => {
  it("POST bez nagłówka X-CSRF-Token jest odrzucany", async () => {
    actAs(db, admin);
    dropCsrfHeader();
    const res = await workersRoute.POST(
      jsonRequest("http://x/api/workers", {
        method: "POST",
        body: { firstName: "Nowy", lastName: "Pracownik", orgUnitId: sklepId },
      }),
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("csrf");
  });

  it("POST ze złym tokenem CSRF jest odrzucany", async () => {
    actAs(db, admin);
    setCsrfHeader("zmyslony-token");
    const res = await workersRoute.POST(
      jsonRequest("http://x/api/workers", {
        method: "POST",
        body: { firstName: "Nowy", lastName: "Pracownik" },
      }),
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("csrf");
  });

  it("GET nie wymaga CSRF (tylko operacje zapisu)", async () => {
    actAs(db, admin);
    dropCsrfHeader();
    const res = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(res.status).toBe(200);
  });
});

describe("rola audytora — tylko odczyt", () => {
  beforeEach(() => {
    actAs(db, audytor);
  });

  it("może czytać listę i kartotekę", async () => {
    const list = await workersRoute.GET(new Request("http://x/api/workers"));
    expect(list.status).toBe(200);
    const detail = await workerRoute.GET(new Request("http://x/api/workers/1"), {
      params: Promise.resolve({ id: String(workerId) }),
    });
    expect(detail.status).toBe(200);
  });

  it("może czytać audyt", async () => {
    const res = await auditRoute.GET(new Request("http://x/api/audit"));
    expect(res.status).toBe(200);
  });

  it("NIE może utworzyć pracownika", async () => {
    const res = await workersRoute.POST(
      jsonRequest("http://x/api/workers", { body: { firstName: "X", lastName: "Y" } }),
    );
    expect(res.status).toBe(403);
  });

  it("NIE może edytować pracownika", async () => {
    const res = await workerRoute.PATCH(jsonRequest("http://x/api/workers/1", { method: "PATCH", body: { position: "Haker" } }), {
      params: Promise.resolve({ id: String(workerId) }),
    });
    expect(res.status).toBe(403);
    expect(getWorkerDetail(db, workerId)!.position).not.toBe("Haker");
  });

  it("NIE może archiwizować pracownika", async () => {
    const res = await workerActionRoute.POST(
      jsonRequest("http://x/api/workers/1/archive"),
      { params: Promise.resolve({ id: String(workerId), action: "archive" }) },
    );
    expect(res.status).toBe(403);
    expect(getWorkerDetail(db, workerId)!.status).toBe("aktywny");
  });

  it("NIE może dodać dostępu", async () => {
    const res = await accessesRoute.POST(
      jsonRequest("http://x/api/workers/1/accesses", {
        body: { categoryId: getCategoryBySlug(db, "chip")!.id, values: { number: "1", level: ["alarm"] } },
      }),
      { params: Promise.resolve({ id: String(workerId) }) },
    );
    expect(res.status).toBe(403);
  });

  it("NIE może podejrzeć sekretu (nawet po reauth)", async () => {
    actAs(db, audytor, { reauth: true });
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password" } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(403);
    expect(JSON.stringify(await readJsonBody(res))).not.toContain(SECRET);
  });

  it("NIE może wyeksportować sekretów", async () => {
    const res = await exportRoute.GET(new Request(`http://x/api/workers/${workerId}/export?includeSecrets=1`), {
      params: Promise.resolve({ id: String(workerId) }),
    });
    expect(res.status).toBe(403);
  });

  it("MOŻE weryfikować łańcuch audytu — to sedno jego roli", async () => {
    const res = await auditVerifyRoute.GET();
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ valid: boolean }>(res);
    expect(body.valid).toBe(true);
  });
});

describe("bramka ponownego potwierdzenia hasła (reveal)", () => {
  it("bez świeżego reauth zwraca 403 reauth_required", async () => {
    actAs(db, operator);
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password" } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("reauth_required");
  });

  it("sfałszowana flaga reauth:true w treści NIE wystarcza", async () => {
    actAs(db, operator);
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password", reauth: true } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("reauth_required");
  });

  it("po świeżym reauth odszyfrowuje sekret i loguje zdarzenie", async () => {
    actAs(db, operator, { reauth: true });
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password" } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ values: string[]; expiresInSeconds: number }>(res);
    expect(body.values).toEqual([SECRET]);
    expect(body.expiresInSeconds).toBe(30);
    const audit = db.prepare("SELECT COUNT(*) AS c FROM audit_events WHERE action='secret.revealed'").get() as {
      c: number;
    };
    expect(audit.c).toBe(1);
  });

  it("reauth starszy niż 5 minut nie wystarcza", async () => {
    actAs(db, operator, { reauth: true });
    db.prepare("UPDATE sessions SET reauth_at = ?").run(Date.now() - 6 * 60 * 1000);
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password" } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("reauth_required");
  });

  it("reauth jednej sesji nie odblokowuje innej sesji", async () => {
    // Operator ma świeży reauth w jednej sesji...
    actAs(db, operator, { reauth: true });
    // ...a inna sesja (np. druga przeglądarka) nie ma.
    const second = actAs(db, operator);
    expect(second.token).toBeTruthy();
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: { fieldKey: "password" } }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(403);
    expect((await readJsonBody(res)).code).toBe("reauth_required");
  });

  it("brak fieldKey zwraca 400", async () => {
    actAs(db, operator, { reauth: true });
    const res = await revealRoute.POST(
      jsonRequest(`http://x/api/accesses/${accessId}/reveal`, { body: {} }),
      { params: Promise.resolve({ id: String(accessId) }) },
    );
    expect(res.status).toBe(400);
  });
});

describe("sekrety nie wyciekają w zwykłych odpowiedziach", () => {
  beforeEach(() => {
    actAs(db, operator);
  });

  it("lista pracowników nie zawiera plaintextu", async () => {
    const res = await workersRoute.GET(new Request("http://x/api/workers?status=wszyscy"));
    expect(res.status).toBe(200);
    expect(await res.text()).not.toContain(SECRET);
  });

  it("kartoteka nie zawiera plaintextu, ale sygnalizuje hasValue", async () => {
    const res = await workerRoute.GET(new Request("http://x/api/workers/1"), {
      params: Promise.resolve({ id: String(workerId) }),
    });
    const text = await res.text();
    expect(text).not.toContain(SECRET);
    const body = JSON.parse(text) as { accesses: { fields: { key: string; secret: boolean; hasValue: boolean }[] }[] };
    const password = body.accesses[0].fields.find((f) => f.key === "password")!;
    expect(password.secret).toBe(true);
    expect(password.hasValue).toBe(true);
  });

  it("eksport domyślny nie zawiera plaintextu", async () => {
    const res = await exportRoute.GET(new Request(`http://x/api/workers/${workerId}/export`), {
      params: Promise.resolve({ id: String(workerId) }),
    });
    const text = await res.text();
    expect(res.status).toBe(200);
    expect(text).not.toContain(SECRET);
    expect(text).toContain("[pominięto]");
  });
});

describe("administracja kontami", () => {
  it("operator nie widzi listy kont", async () => {
    actAs(db, operator);
    const res = await adminUsersRoute.GET();
    expect(res.status).toBe(403);
  });

  it("admin widzi konta bez hashy haseł", async () => {
    actAs(db, admin);
    const res = await adminUsersRoute.GET();
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ users: Record<string, unknown>[] }>(res);
    expect(body.users).toHaveLength(3);
    expect(JSON.stringify(body.users)).not.toContain("$argon2");
  });

  it("nie można zdegradować ostatniego administratora", async () => {
    actAs(db, admin);
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://x/api/admin/users/${admin.id}`, { method: "PATCH", body: { role: "operator" } }),
      { params: Promise.resolve({ id: String(admin.id) }) },
    );
    expect(res.status).toBe(400);
    expect((await readJsonBody(res)).code).toBe("last_admin");
  });

  it("nie można wyłączyć ostatniego administratora", async () => {
    actAs(db, admin);
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://x/api/admin/users/${admin.id}`, { method: "PATCH", body: { isActive: false } }),
      { params: Promise.resolve({ id: String(admin.id) }) },
    );
    expect(res.status).toBe(400);
    expect((await readJsonBody(res)).code).toBe("last_admin");
  });

  it("egzekwuje limit 5 aktywnych kont serwerowo", async () => {
    actAs(db, admin);
    // Mamy już 3 konta — dobijamy do 5.
    for (const name of ["czwarty", "piaty"]) {
      const created = await adminUsersRoute.POST(
        jsonRequest("http://x/api/admin/users", {
          body: { username: name, displayName: name, role: "operator" },
        }),
      );
      expect(created.status).toBe(201);
    }
    const over = await adminUsersRoute.POST(
      jsonRequest("http://x/api/admin/users", {
        body: { username: "szosty", displayName: "Szósty", role: "operator" },
      }),
    );
    expect(over.status).toBe(409);
    expect((await readJsonBody(over)).code).toBe("user_limit");
    const count = db.prepare("SELECT COUNT(*) AS c FROM app_users WHERE is_active = 1").get() as { c: number };
    expect(count.c).toBe(5);
  });

  it("wyłączone konto nie liczy się do limitu", async () => {
    actAs(db, admin);
    for (const name of ["czwarty", "piaty"]) {
      await adminUsersRoute.POST(
        jsonRequest("http://x/api/admin/users", { body: { username: name, displayName: name, role: "operator" } }),
      );
    }
    db.prepare("UPDATE app_users SET is_active = 0 WHERE username = 'audyt1'").run();
    const created = await adminUsersRoute.POST(
      jsonRequest("http://x/api/admin/users", {
        body: { username: "szosty", displayName: "Szósty", role: "operator" },
      }),
    );
    expect(created.status).toBe(201);
  });

  /**
   * Reset 2FA to jedyna droga ratunku dla osoby, która zgubiła telefon ORAZ kody
   * odzyskiwania. Bez niego konto jest trwale zablokowane, a system ma być
   * „dostępny zawsze". Reset musi być: możliwy tylko dla admina, na cudzym koncie,
   * z wpisem w audycie i bez ujawniania sekretu w odpowiedzi.
   */
  it("admin może zresetować 2FA innemu kontu", async () => {
    const { enrollTotp } = await import("@/lib/auth/service");
    enrollTotp(db, operator.id, null);
    const before = db.prepare("SELECT totp_enabled FROM app_users WHERE id = ?").get(operator.id) as {
      totp_enabled: number;
    };
    expect(before.totp_enabled).toBe(1);

    actAs(db, admin);
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://x/api/admin/users/${operator.id}`, { method: "PATCH", body: { resetTotp: true } }),
      { params: Promise.resolve({ id: String(operator.id) }) },
    );
    expect(res.status).toBe(200);

    // Odpowiedź nie może zawierać sekretu ani kodów odzyskiwania.
    const body = await readJsonBody<Record<string, unknown>>(res);
    expect(JSON.stringify(body)).not.toMatch(/[A-Z2-7]{32}/);
    expect(body.recoveryCodes).toBeUndefined();

    const after = db.prepare("SELECT totp_enabled, totp_secret_enc FROM app_users WHERE id = ?").get(operator.id) as {
      totp_enabled: number;
      totp_secret_enc: string | null;
    };
    expect(after.totp_enabled).toBe(0);
    expect(after.totp_secret_enc).toBeNull();
    // Wpisy kluczy dla tego użytkownika też znikają — brak osieroconych rekordów.
    const secrets = db.prepare("SELECT COUNT(*) AS c FROM app_user_secrets WHERE user_id = ?").get(operator.id) as {
      c: number;
    };
    expect(secrets.c).toBe(0);

    const audit = db.prepare("SELECT summary FROM audit_events WHERE action = 'auth.totp_reset'").get() as
      | { summary: string }
      | undefined;
    expect(audit?.summary).toContain("oper1");
  });

  it("operator nie może zresetować cudzego 2FA", async () => {
    const { enrollTotp } = await import("@/lib/auth/service");
    enrollTotp(db, admin.id, null);
    actAs(db, operator);
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://x/api/admin/users/${admin.id}`, { method: "PATCH", body: { resetTotp: true } }),
      { params: Promise.resolve({ id: String(admin.id) }) },
    );
    expect(res.status).toBe(403);
    const row = db.prepare("SELECT totp_enabled FROM app_users WHERE id = ?").get(admin.id) as { totp_enabled: number };
    expect(row.totp_enabled).toBe(1);
  });

  it("admin nie może zresetować własnego 2FA tą drogą (musi użyć /api/account/2fa)", async () => {
    const { enrollTotp } = await import("@/lib/auth/service");
    enrollTotp(db, admin.id, null);
    actAs(db, admin);
    const res = await adminUserRoute.PATCH(
      jsonRequest(`http://x/api/admin/users/${admin.id}`, { method: "PATCH", body: { resetTotp: true } }),
      { params: Promise.resolve({ id: String(admin.id) }) },
    );
    // Własne 2FA wyłącza się świadomym DELETE /api/account/2fa — admin nie może
    // przypadkiem odciąć sobie drugiego składnika przez panel administracji.
    expect(res.status).toBe(400);
    expect((await readJsonBody(res)).code).toBe("self_totp");
    const row = db.prepare("SELECT totp_enabled FROM app_users WHERE id = ?").get(admin.id) as { totp_enabled: number };
    expect(row.totp_enabled).toBe(1);
  });

  it("reset 2FA nieistniejącego konta zwraca 404", async () => {
    actAs(db, admin);
    const res = await adminUserRoute.PATCH(
      jsonRequest("http://x/api/admin/users/99999", { method: "PATCH", body: { resetTotp: true } }),
      { params: Promise.resolve({ id: "99999" }) },
    );
    expect(res.status).toBe(404);
  });
});

describe("zdrowie aplikacji", () => {
  it("/api/health działa bez logowania", async () => {
    const healthRoute = await import("@/app/api/health/route");
    actAsAnonymous();
    const res = await healthRoute.GET();
    expect(res.status).toBe(200);
    const body = await readJsonBody<{ status: string; keys: number }>(res);
    expect(body.status).toBe("ok");
    expect(body.keys).toBeGreaterThanOrEqual(1);
  });
});

describe("usuwanie dostępu", () => {
  it("operator może wycofać dostęp", async () => {
    actAs(db, operator);
    const res = await accessRoute.DELETE(jsonRequest(`http://x/api/accesses/${accessId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: String(accessId) }),
    });
    expect(res.status).toBe(200);
    expect(getWorkerDetail(db, workerId)!.accesses[0].status).toBe("wycofany");
  });

  it("audytor nie może wycofać dostępu", async () => {
    actAs(db, audytor);
    const res = await accessRoute.DELETE(jsonRequest(`http://x/api/accesses/${accessId}`, { method: "DELETE" }), {
      params: Promise.resolve({ id: String(accessId) }),
    });
    expect(res.status).toBe(403);
    expect(getWorkerDetail(db, workerId)!.accesses[0].status).toBe("aktywny");
  });
});
