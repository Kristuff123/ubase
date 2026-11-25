import { expect, test } from "./fixtures";
import { ACCOUNTS, TOTP_SECRET } from "./seed.mjs";
import { GLOBAL_CLIENT_IP, login, newClientContext, restoreAccounts, totpCode } from "./helpers";

/**
 * Moje konto: zmiana hasła i włączanie 2FA.
 *
 * Każdy test przywraca stan wyjściowy, bo plik działa na współdzielonej bazie:
 *  - zmiana hasła wraca do hasła z seeda,
 *  - włączone 2FA jest zdejmowane przez admina (reset 2FA w panelu).
 */
test.describe("moje konto", () => {
  // Ten plik zakłada, że konta seedowe są aktywne. Wcześniejsze pliki specy
  // mogą zostawić konto wyłączone, jeśli przerwie się test sprzątający.
  test.beforeAll(async ({ browser }) => {
    const context = await newClientContext(browser, GLOBAL_CLIENT_IP, 0);
    const page = await context.newPage();
    await login(page, "admin");
    await restoreAccounts(page);
    await context.close();
  });

  test("pokazuje dane konta i sekcje bezpieczeństwa", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/konto");

    await expect(page.getByRole("heading", { name: "Moje konto" })).toBeVisible();
    // Nazwa wyświetlana jest też w nagłówku — bierzemy pierwsze wystąpienie.
    await expect(page.getByText(/Anna Admin/).first()).toBeVisible();
    await expect(page.getByRole("heading", { name: "Uwierzytelnianie dwuskładnikowe" })).toBeVisible();
    await expect(page.getByRole("heading", { name: "Zmiana hasła" })).toBeVisible();
    await expect(page.getByText("Minimum 12 znaków. Zmiana wylogowuje wszystkie inne sesje.")).toBeVisible();
  });

  test("zmiana hasła odrzuca niezgodne powtórzenie", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/konto");

    await page.locator("#cp-current").fill(ACCOUNTS.admin.password);
    await page.locator("#cp-new").fill("Nowe-Haslo-Bardzo-Dlugie-1");
    await page.locator("#cp-repeat").fill("Inne-Haslo-Bardzo-Dlugie-2");
    await page.getByRole("button", { name: "Zmień hasło" }).click();

    await expect(page.getByText("Nowe hasła nie są identyczne")).toBeVisible();
  });

  test("zmiana hasła odrzuca błędne obecne hasło", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/konto");

    await page.locator("#cp-current").fill("zupelnie-bledne-haslo");
    await page.locator("#cp-new").fill("Nowe-Haslo-Bardzo-Dlugie-1");
    await page.locator("#cp-repeat").fill("Nowe-Haslo-Bardzo-Dlugie-1");
    await page.getByRole("button", { name: "Zmień hasło" }).click();

    await expect(page.getByText(/Nieprawidłowe obecne hasło/)).toBeVisible({ timeout: 15_000 });
  });

  test("zmiana hasła działa, stare przestaje działać, a stan wraca do seeda", async ({ page, clientIp }) => {
    const newPassword = "Audytor-Nowe-Haslo-2026!";
    await login(page, "audytor");
    await page.goto("/konto");

    await page.locator("#cp-current").fill(ACCOUNTS.audytor.password);
    await page.locator("#cp-new").fill(newPassword);
    await page.locator("#cp-repeat").fill(newPassword);
    await page.getByRole("button", { name: "Zmień hasło" }).click();
    await expect(page.getByText("Hasło zmienione")).toBeVisible({ timeout: 20_000 });

    // Bieżąca sesja pozostaje ważna — użytkownik nie jest wyrzucany po zmianie.
    await expect(page.getByRole("heading", { name: "Moje konto" })).toBeVisible();

    // Stare hasło nie działa, nowe tak.
    const other = await (await newClientContext(page.context().browser()!, clientIp, 1)).newPage();
    await other.goto("/login");
    await other.getByLabel("Login").fill(ACCOUNTS.audytor.username);
    await other.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.audytor.password);
    await other.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(other.getByText("Nieprawidłowy login lub hasło")).toBeVisible({ timeout: 15_000 });

    await other.getByLabel("Hasło", { exact: true }).fill(newPassword);
    await other.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(other.getByRole("heading", { name: "Pracownicy" })).toBeVisible({ timeout: 15_000 });
    await other.context().close();

    // Przywracamy hasło z seeda, żeby kolejne pliki specy działały.
    await page.goto("/konto");
    await page.locator("#cp-current").fill(newPassword);
    await page.locator("#cp-new").fill(ACCOUNTS.audytor.password);
    await page.locator("#cp-repeat").fill(ACCOUNTS.audytor.password);
    await page.getByRole("button", { name: "Zmień hasło" }).click();
    await expect(page.getByText("Hasło zmienione")).toBeVisible({ timeout: 20_000 });
  });

  test("włączenie 2FA pokazuje QR, sekret i 10 unikalnych kodów odzyskiwania", async ({ page, clientIp }) => {
    await login(page, "operator");
    await page.goto("/konto");

    await expect(page.locator(".ub-chip", { hasText: /^(włączone|wyłączone)$/ }).first()).toHaveText("wyłączone");
    await page.getByRole("button", { name: "Włącz 2FA" }).click();

    // QR generowany serwerowo jako data-URL PNG.
    const qr = page.getByRole("img", { name: "Kod QR do aplikacji uwierzytelniającej" });
    await expect(qr).toBeVisible({ timeout: 20_000 });
    expect(await qr.getAttribute("src")).toMatch(/^data:image\/png;base64,/);

    // Sekret base32 do ręcznego wpisania w aplikacji.
    const secret = (await page.locator("code.ub-mono.break-all").innerText()).trim();
    expect(secret).toMatch(/^[A-Z2-7]{16,}$/);

    // 10 unikalnych kodów w formacie xxxx-xxxx.
    const codes = page.locator("code.ub-mono.rounded.border");
    await expect(codes).toHaveCount(10);
    const values = (await codes.allInnerTexts()).map((code) => code.trim());
    for (const code of values) expect(code).toMatch(/^[a-z0-9]{4}-[a-z0-9]{4}$/);
    expect(new Set(values).size).toBe(10);

    // „Zakończ" zablokowane do potwierdzenia zapisania kodów.
    const finish = page.getByRole("button", { name: "Zakończ" });
    await expect(finish).toBeDisabled();
    await page.getByLabel("Zapisałem kody odzyskiwania w bezpiecznym miejscu").check();
    await expect(finish).toBeEnabled();
    await finish.click();

    await expect(page.locator(".ub-chip", { hasText: "włączone" }).first()).toBeVisible({ timeout: 15_000 });

    // Sprzątanie: admin resetuje 2FA operatora (w UI panelu administracji).
    const adminContext = await newClientContext(page.context().browser()!, clientIp, 2);
    const adminPage = await adminContext.newPage();
    await login(adminPage, "admin");
    await adminPage.goto("/administracja");
    const row = adminPage.getByRole("row", { name: /operator/ });
    adminPage.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "reset 2FA" }).click();
    await expect(adminPage.getByText("2FA zresetowane")).toBeVisible({ timeout: 15_000 });
    await adminContext.close();
  });

  test("konto z 2FA wymaga kodu przy logowaniu", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.dwaFa.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.dwaFa.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();

    await expect(page.getByLabel("Kod")).toBeVisible({ timeout: 15_000 });
    await page.getByLabel("Kod").fill(totpCode(TOTP_SECRET));
    await page.getByRole("button", { name: "Potwierdź kod" }).click();

    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible({ timeout: 15_000 });
    await page.goto("/konto");
    await expect(page.locator(".ub-chip", { hasText: "włączone" }).first()).toBeVisible();
  });

  test("błędny kod 2FA nie kończy logowania", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.dwaFa.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.dwaFa.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(page.getByLabel("Kod")).toBeVisible({ timeout: 15_000 });

    await page.getByLabel("Kod").fill("000000");
    await page.getByRole("button", { name: "Potwierdź kod" }).click();
    await expect(page.getByText(/Nieprawidłowy kod|nieprawidłow/i).first()).toBeVisible({ timeout: 15_000 });
    await expect(page).toHaveURL(/\/login/);

    // Sesja pozostaje w stanie pending — endpointy danych jej nie akceptują.
    // `/api/auth/me` odpowiada wtedy 401 z kodem `pending_2fa` (nie `user: null`),
    // bo niekompletne logowanie nie jest sesją.
    // `page.request` dzieli ciasteczka z przeglądarką; `request` to osobny kontekst
    // bez sesji, więc zawsze dostałby `unauthenticated`.
    const me = await page.request.get("/api/auth/me");
    expect(me.status()).toBe(401);
    expect((await me.json()) as { code: string }).toMatchObject({ code: "pending_2fa" });
  });

  test("ponowne włączenie 2FA generuje nowy sekret i rozłączne kody", async ({ page, clientIp }) => {
    await login(page, "operator");

    const headers = async () => {
      const cookies = await page.context().cookies();
      return {
        "X-CSRF-Token": cookies.find((cookie) => cookie.name === "ub_csrf")!.value,
        Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
      };
    };

    const first = await page.request.post("/api/account/2fa", { headers: await headers() });
    expect(first.status()).toBe(200);
    const firstBody = (await first.json()) as { secret: string; recoveryCodes: string[] };
    expect(firstBody.recoveryCodes).toHaveLength(10);

    const second = await page.request.post("/api/account/2fa", { headers: await headers() });
    expect(second.status()).toBe(200);
    const secondBody = (await second.json()) as { secret: string; recoveryCodes: string[] };

    expect(secondBody.secret).not.toBe(firstBody.secret);
    const overlap = firstBody.recoveryCodes.filter((code) => secondBody.recoveryCodes.includes(code));
    expect(overlap).toHaveLength(0);

    // Sprzątanie: admin zdejmuje 2FA z konta operatora.
    const adminContext = await newClientContext(page.context().browser()!, clientIp, 2);
    const adminPage = await adminContext.newPage();
    await login(adminPage, "admin");
    await adminPage.goto("/administracja");
    const row = adminPage.getByRole("row", { name: /operator/ });
    adminPage.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "reset 2FA" }).click();
    await expect(adminPage.getByText("2FA zresetowane")).toBeVisible({ timeout: 15_000 });
    await adminContext.close();
  });
});
