import { expect, test } from "./fixtures";
import { ACCOUNTS, SECRET_PASSWORD } from "./seed.mjs";
import { apiLogin, login } from "./helpers";

/**
 * Role i uprawnienia. Najważniejsza reguła tego systemu: audytor widzi wszystko,
 * ale nie zmienia niczego i nie widzi sekretów. Weryfikujemy to na trzech
 * poziomach — nawigacja, redirecty stron i API (bo UI da się obejść curlem).
 */
test.describe("role", () => {
  test("audytor widzi dane, ale nie ma akcji edycyjnych", async ({ page }) => {
    await login(page, "audytor");

    // Lista i dane są widoczne — audytor ma pełny wgląd w kartoteki.
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Żółkiewska Zofia/ })).toBeVisible();

    // Brak przycisku dodawania — audytor nie tworzy pracowników.
    await expect(page.getByRole("button", { name: /Nowy pracownik/ })).toHaveCount(0);

    // W nawigacji nie ma Importu ani Administracji (role-gated w powłoce).
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "Audyt" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Import" })).toHaveCount(0);
    await expect(nav.getByRole("link", { name: "Administracja" })).toHaveCount(0);
  });

  test("audytor nie widzi przycisku podejrzenia sekretu", async ({ page }) => {
    await login(page, "audytor");
    await page.goto("/pracownicy/1");

    await expect(page.getByRole("heading", { name: "Zofia Żółkiewska" })).toBeVisible();
    await expect(page.getByRole("button", { name: "pokaż", exact: true })).toHaveCount(0);
    // Wartość pozostaje zamaskowana (karta ma login jawny + hasło pod kropkami).
    await expect(page.getByText(SECRET_PASSWORD)).toHaveCount(0);
    await expect(page.getByText("••••••••").first()).toBeVisible();
  });

  test("audytor nie ma akcji edycyjnych w kartotece", async ({ page }) => {
    await login(page, "audytor");
    await page.goto("/pracownicy/1");

    await expect(page.getByRole("button", { name: /Dodaj dostęp/ })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Edytuj dane" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Archiwizuj" })).toHaveCount(0);
    // Eksport RODO jest dozwolony — to uprawnienie odczytu.
    await expect(page.getByRole("link", { name: "Eksport danych" })).toBeVisible();
  });

  test("audytor nie wejdzie na /import ani /administracja", async ({ page }) => {
    await login(page, "audytor");

    await page.goto("/import");
    // redirect("/") — serwer nie renderuje strony, przeglądarka ląduje na liście.
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Import z Excela" })).toHaveCount(0);

    await page.goto("/administracja");
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Administracja" })).toHaveCount(0);
  });

  test("API blokuje zapis dla audytora (403), nie tylko UI", async ({ request }) => {
    const session = await apiLogin(request, "audytor");
    const headers = {
      "X-CSRF-Token": session.csrf,
      Cookie: `ub_session=${session.token}; ub_csrf=${session.csrf}`,
    };

    // Próba utworzenia pracownika.
    const create = await request.post("/api/workers", {
      headers,
      data: { firstName: "Test", lastName: "Audytora" },
    });
    expect(create.status()).toBe(403);

    // Próba podejrzenia sekretu — najważniejsza granica w systemie.
    const reveal = await request.post("/api/accesses/1/reveal", {
      headers,
      data: { fieldKey: "password" },
    });
    expect(reveal.status()).toBe(403);

    // Próba utworzenia konta aplikacji.
    const user = await request.post("/api/admin/users", {
      headers,
      data: { username: "hacker", displayName: "Haker", role: "admin" },
    });
    expect(user.status()).toBe(403);

    // Odczyt nadal działa.
    const list = await request.get("/api/workers", {
      headers: { Cookie: `ub_session=${session.token}` },
    });
    expect(list.status()).toBe(200);
    const body = (await list.json()) as { total: number };
    expect(body.total).toBeGreaterThan(0);
  });

  test("operator nie wejdzie do administracji, ale może edytować", async ({ page }) => {
    await login(page, "operator");

    // Operator ma Import, ale nie ma Administracji.
    const nav = page.locator("aside nav");
    await expect(nav.getByRole("link", { name: "Import" })).toBeVisible();
    await expect(nav.getByRole("link", { name: "Administracja" })).toHaveCount(0);

    await page.goto("/administracja");
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();

    // Edycja pracowników jest dozwolona.
    await expect(page.getByRole("button", { name: /Nowy pracownik/ })).toBeVisible();
  });

  test("operator nie może tworzyć kont aplikacji", async ({ request }) => {
    const session = await apiLogin(request, "operator");
    const response = await request.post("/api/admin/users", {
      headers: {
        "X-CSRF-Token": session.csrf,
        Cookie: `ub_session=${session.token}; ub_csrf=${session.csrf}`,
      },
      data: { username: "nowykonto", displayName: "Nowe Konto", role: "operator" },
    });
    expect(response.status()).toBe(403);
  });

  test("żądanie zapisu bez tokenu CSRF jest odrzucane", async ({ request }) => {
    const session = await apiLogin(request, "admin");
    const response = await request.post("/api/workers", {
      headers: { Cookie: `ub_session=${session.token}` },
      data: { firstName: "Bez", lastName: "Csrf" },
    });
    expect(response.status()).toBe(403);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("csrf");
  });

  test("zdegradowany do audytora operator traci dostęp do sekretów", async ({ page, request }) => {
    // Admin zmienia rolę konta `dwaefa` (operator → audytor) przez API.
    const admin = await apiLogin(request, "admin");
    const adminHeaders = {
      "X-CSRF-Token": admin.csrf,
      Cookie: `ub_session=${admin.token}; ub_csrf=${admin.csrf}`,
    };
    const users = await request.get("/api/admin/users", {
      headers: { Cookie: `ub_session=${admin.token}` },
    });
    const list = (await users.json()) as { users: { id: number; username: string }[] };
    const target = list.users.find((user) => user.username === ACCOUNTS.dwaFa.username)!;

    try {
      const downgrade = await request.patch(`/api/admin/users/${target.id}`, {
        headers: adminHeaders,
        data: { role: "audytor" },
      });
      expect(downgrade.status()).toBe(200);

      // Konto ma 2FA, więc logowanie przez API wymaga kodu — używamy UI.
      const { loginWithTotp } = await import("./helpers");
      const { TOTP_SECRET } = await import("./seed.mjs");
      await loginWithTotp(page, "dwaFa", TOTP_SECRET);

      await page.goto("/pracownicy/1");
      await expect(page.getByRole("button", { name: "pokaż", exact: true })).toHaveCount(0);
    } finally {
      // Przywracamy rolę, żeby nie psuć innych plików specy.
      await request.patch(`/api/admin/users/${target.id}`, {
        headers: adminHeaders,
        data: { role: "operator" },
      });
    }
  });

  test("admin nie może odebrać uprawnień ostatniemu administratorowi", async ({ request }) => {
    const admin = await apiLogin(request, "admin");
    const headers = {
      "X-CSRF-Token": admin.csrf,
      Cookie: `ub_session=${admin.token}; ub_csrf=${admin.csrf}`,
    };
    const users = await request.get("/api/admin/users", { headers: { Cookie: `ub_session=${admin.token}` } });
    const list = (await users.json()) as { users: { id: number; username: string; role: string }[] };
    const self = list.users.find((user) => user.username === ACCOUNTS.admin.username)!;

    const response = await request.patch(`/api/admin/users/${self.id}`, {
      headers,
      data: { role: "operator" },
    });
    expect(response.status()).toBe(400);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("last_admin");
  });
});
