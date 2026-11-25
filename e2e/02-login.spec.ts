import { expect, test } from "./fixtures";
import { ACCOUNTS, TOTP_SECRET } from "./seed.mjs";
import { login, totpCode } from "./helpers";

/**
 * Logowanie przez UI: hasło, 2FA, ochrona przez rate limit i wylogowanie.
 * Każdy test używa własnego kontekstu przeglądarki (izolacja cookies).
 */
test.describe("logowanie", () => {
  test("poprawne dane logują i pokazują listę pracowników", async ({ page }) => {
    await login(page, "admin");
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.getByText(ACCOUNTS.admin.displayName)).toBeVisible();
  });

  test("błędne hasło pokazuje komunikat i nie wpuszcza", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.admin.username);
    await page.getByLabel("Hasło", { exact: true }).fill("zupelnie-bledne-haslo");
    await page.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(page.getByText("Nieprawidłowy login lub hasło")).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });

  test("nieznane konto daje ten sam komunikat co błędne hasło", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill("nieistniejacy");
    await page.getByLabel("Hasło", { exact: true }).fill("cokolwiek-123456");
    await page.getByRole("button", { name: "Zaloguj się" }).click();
    // Brak rozróżnienia chroni przed enumeracją kont.
    await expect(page.getByText("Nieprawidłowy login lub hasło")).toBeVisible();
  });

  test("konto z 2FA wymaga kodu, potem wpuszcza", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.dwaFa.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.dwaFa.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();

    await expect(page.getByLabel("Kod")).toBeVisible();
    await expect(page.getByText("Wpisz 6-cyfrowy kod")).toBeVisible();
    await page.getByLabel("Kod").fill(totpCode(TOTP_SECRET));
    await page.getByRole("button", { name: "Potwierdź kod" }).click();

    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
  });

  test("błędny kod 2FA nie wpuszcza i pozwala wrócić do hasła", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.dwaFa.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.dwaFa.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();

    await page.getByLabel("Kod").fill("000000");
    await page.getByRole("button", { name: "Potwierdź kod" }).click();
    await expect(page.getByText("Nieprawidłowy kod")).toBeVisible();

    await page.getByRole("button", { name: "Wróć" }).click();
    await expect(page.getByLabel("Login")).toBeVisible();
  });

  test("sesja pending_2fa nie daje dostępu do API", async ({ page }) => {
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.dwaFa.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.dwaFa.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(page.getByLabel("Kod")).toBeVisible();

    const response = await page.request.get("/api/workers");
    expect(response.status()).toBe(401);
    expect((await response.json()).code).toBe("pending_2fa");

    // Strona też nie może się otworzyć.
    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("wylogowanie kończy sesję i blokuje powrót", async ({ page }) => {
    await login(page, "admin");
    await page.getByTitle("Wyloguj").click();
    await expect(page).toHaveURL(/\/login/);

    await page.goto("/");
    await expect(page).toHaveURL(/\/login/);
  });

  test("pięć błędnych prób blokuje konto", async ({ page }) => {
    // Limit konta to 5 prób / 15 min — liczony po stronie serwera.
    // Używamy konta `blokada`: zablokowanie `operator` wysypałoby kolejne pliki specy.
    for (let attempt = 0; attempt < 5; attempt += 1) {
      await page.goto("/login");
      await page.getByLabel("Login").fill(ACCOUNTS.blokada.username);
      await page.getByLabel("Hasło", { exact: true }).fill(`bledne-haslo-${attempt}`);
      await page.getByRole("button", { name: "Zaloguj się" }).click();
      await expect(page.locator('[class*="ub-danger"]').first()).toBeVisible();
    }

    // Szósta próba — nawet z poprawnym hasłem — trafia na blokadę.
    await page.goto("/login");
    await page.getByLabel("Login").fill(ACCOUNTS.blokada.username);
    await page.getByLabel("Hasło", { exact: true }).fill(ACCOUNTS.blokada.password);
    await page.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(page.getByText(/zablokowane|Zbyt wiele prób/i)).toBeVisible();
    await expect(page).toHaveURL(/\/login/);
  });
});
