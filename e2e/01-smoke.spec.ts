import { expect, test } from "./fixtures";
import { login } from "./helpers";

/**
 * Dym: czy build produkcyjny za TLS w ogóle się uruchamia i autoryzuje.
 * Ten plik jako pierwszy sygnalizuje problemy z infrastrukturą E2E.
 */
test.describe("infrastruktura", () => {
  test("health endpoint odpowiada i widzi klucz danych", async ({ request }) => {
    const response = await request.get("/api/health");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { status: string; db: boolean; keys: number; schemaVersion: number };
    expect(body.status).toBe("ok");
    expect(body.db).toBe(true);
    expect(body.keys).toBeGreaterThan(0);
    expect(body.schemaVersion).toBeGreaterThanOrEqual(3);
  });

  test("niezalogowany użytkownik jest przekierowany na /login", async ({ page }) => {
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("API bez sesji zwraca 401", async ({ request }) => {
    const response = await request.get("/api/workers");
    expect(response.status()).toBe(401);
    expect((await response.json()).code).toBe("unauthenticated");
  });

  test("cookie sesji jest HttpOnly i Secure, CSRF czytelny dla JS", async ({ page, context }) => {
    await login(page, "admin");
    const cookies = await context.cookies();
    const session = cookies.find((cookie) => cookie.name === "ub_session");
    const csrf = cookies.find((cookie) => cookie.name === "ub_csrf");
    expect(session?.httpOnly).toBe(true);
    expect(session?.secure).toBe(true);
    expect(csrf?.httpOnly).toBe(false);
    expect(csrf?.secure).toBe(true);
  });

  test("nagłówki bezpieczeństwa są wysyłane", async ({ page }) => {
    const response = await page.goto("/login");
    const headers = response!.headers();
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("no-referrer");
    expect(headers["content-security-policy"]).toContain("default-src 'self'");
    expect(headers["strict-transport-security"]).toContain("max-age=");
    expect(headers["x-powered-by"]).toBeUndefined();
  });

  test("CSP używa świeżego nonce dla skryptów każdej odpowiedzi", async ({ page }) => {
    const firstResponse = await page.goto("/login");
    const firstCsp = firstResponse!.headers()["content-security-policy"];
    const firstNonce = firstCsp.match(/'nonce-([^']+)'/)?.[1];

    expect(firstNonce).toBeTruthy();
    expect(firstCsp).not.toContain("'unsafe-inline'");
    const scriptNonces = await page.locator("script").evaluateAll((scripts) =>
      scripts.map((script) => (script as HTMLScriptElement).nonce),
    );
    expect(scriptNonces.length).toBeGreaterThan(0);
    expect(scriptNonces.every((nonce) => nonce === firstNonce), JSON.stringify(scriptNonces)).toBe(true);

    const secondResponse = await page.goto("/login");
    const secondCsp = secondResponse!.headers()["content-security-policy"];
    const secondNonce = secondCsp.match(/'nonce-([^']+)'/)?.[1];
    expect(secondNonce).toBeTruthy();
    expect(secondNonce).not.toBe(firstNonce);
  });

  test("strona logowania ładuje style (Tailwind z bundla produkcyjnego)", async ({ page }) => {
    await page.goto("/login");
    const heading = page.getByRole("heading", { name: "Userbase" });
    await expect(heading).toBeVisible();
    // Bez skopiowanego .next/static strona renderuje się bez CSS — sprawdzamy realny styl.
    const box = await heading.boundingBox();
    expect(box?.height ?? 0).toBeGreaterThan(8);
  });
});
