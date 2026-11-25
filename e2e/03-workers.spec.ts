import { expect, test } from "./fixtures";
import { ACCOUNTS, SECRET_PASSWORD } from "./seed.mjs";
import { login } from "./helpers";

/**
 * Pracownicy: lista, wyszukiwanie (odporne na polskie znaki), quick-add,
 * kartoteka, dodawanie dostępu, podejrzenie sekretu za potwierdzeniem hasła
 * i archiwizacja. Testy idą przez UI — to one weryfikują realne UX.
 */
test.describe("pracownicy", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "admin");
  });

  test("lista pokazuje seedowanych pracowników", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Żółkiewska Zofia/ })).toBeVisible();
    // Domyślnie tylko aktywni — archiwum nie może się mieszać z listą.
    await expect(page.getByRole("cell", { name: /Archiwalny Marek/ })).toHaveCount(0);
  });

  test("wyszukiwanie działa bez polskich znaków", async ({ page }) => {
    const search = page.getByLabel("Szukaj pracowników");
    await search.fill("zolkiewska");
    await expect(page.getByRole("cell", { name: /Żółkiewska Zofia/ })).toBeVisible();

    await search.fill("zofia");
    await expect(page.getByRole("cell", { name: /Żółkiewska Zofia/ })).toBeVisible();

    await search.fill("nie-ma-takiej-osoby");
    await expect(page.getByText("Brak wyników")).toBeVisible();
  });

  test("filtr archiwum pokazuje tylko zarchiwizowanych", async ({ page }) => {
    await page.getByRole("button", { name: "Archiwum" }).click();
    await expect(page.getByRole("cell", { name: /Archiwalny Marek/ })).toBeVisible();
    await expect(page.getByRole("cell", { name: /Żółkiewska Zofia/ })).toHaveCount(0);
  });

  test("quick-add tworzy pracownika i przechodzi do kartoteki", async ({ page }) => {
    await page.getByRole("button", { name: /Nowy pracownik/ }).click();
    const dialog = page.getByRole("dialog", { name: "Nowy pracownik" });
    await expect(dialog).toBeVisible();

    await dialog.locator("#fn").fill("Jan");
    await dialog.locator("#ln").fill("Kowalski");
    await dialog.locator("#unit").selectOption({ label: "🏭 PIEKARNIA" });
    await dialog.locator("#pos").fill("piekarz");
    await dialog.getByRole("button", { name: "Zapisz i dodaj dostępy" }).click();

    await expect(page).toHaveURL(/\/pracownicy\/\d+/);
    await expect(page.getByRole("heading", { name: "Jan Kowalski" })).toBeVisible();
    await expect(page.getByText("Brak aktywnych dostępów")).toBeVisible();
  });

  test("duplikat w tej samej jednostce jest wykrywany", async ({ page }) => {
    await page.getByRole("button", { name: /Nowy pracownik/ }).click();
    const dialog = page.getByRole("dialog", { name: "Nowy pracownik" });

    await dialog.locator("#fn").fill("Zofia");
    await dialog.locator("#ln").fill("Żółkiewska");
    await dialog.locator("#unit").selectOption({ label: "🏭 PIEKARNIA" });
    await dialog.getByRole("button", { name: "Zapisz i dodaj dostępy" }).click();

    await expect(dialog.getByText("Taka osoba już istnieje w tej jednostce.")).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Otwórz istniejącą" })).toBeVisible();
    await expect(dialog.getByRole("button", { name: "Dodaj mimo to" })).toBeVisible();
  });

  test("kartoteka pokazuje dane i dostęp bez ujawniania sekretu", async ({ page }) => {
    await page.getByRole("cell", { name: /Żółkiewska Zofia/ }).getByRole("link").click();
    await expect(page.getByRole("heading", { name: "Zofia Żółkiewska" })).toBeVisible();
    await expect(page.locator(".ub-chip", { hasText: "Axel" }).first()).toBeVisible();
    await expect(page.getByText("zofia.piekarnia")).toBeVisible();
    // Hasło musi być zamaskowane, dopóki użytkownik go nie podejrzy.
    await expect(page.getByText(SECRET_PASSWORD)).toHaveCount(0);
    await expect(page.getByText("••••••••")).toBeVisible();
  });

  test("podejrzenie sekretu wymaga potwierdzenia hasła", async ({ page }) => {
    await page.goto("/pracownicy/1");
    await page.getByRole("button", { name: "pokaż", exact: true }).click();

    const dialog = page.getByRole("dialog", { name: "Potwierdź hasło" });
    await expect(dialog).toBeVisible();
    await dialog.getByLabel("Hasło do konta").fill(ACCOUNTS.admin.password);
    await dialog.getByRole("button", { name: "Potwierdź" }).click();

    // Po reauth wartość pojawia się jawnie, z licznikiem ekspozycji.
    await expect(page.getByText(SECRET_PASSWORD)).toBeVisible();
    await expect(page.getByText("30 s", { exact: true })).toBeVisible();
  });

  test("błędne hasło w reauth nie ujawnia sekretu", async ({ page }) => {
    await page.goto("/pracownicy/1");
    await page.getByRole("button", { name: "pokaż", exact: true }).click();
    const dialog = page.getByRole("dialog", { name: "Potwierdź hasło" });
    await dialog.getByLabel("Hasło do konta").fill("bledne-haslo-reauth");
    await dialog.getByRole("button", { name: "Potwierdź" }).click();

    await expect(dialog.getByText(/Nieprawidłowe hasło|Nie udało się/i)).toBeVisible();
    await expect(page.getByText(SECRET_PASSWORD)).toHaveCount(0);
  });

  test("dodanie dostępu z generatorem hasła", async ({ page }) => {
    await page.goto("/pracownicy/1");
    await page.getByRole("button", { name: /Dodaj dostęp/ }).click();

    const dialog = page.getByRole("dialog", { name: "Nowy dostęp" });
    await expect(dialog).toBeVisible();
    await dialog.locator("#acc-cat").selectOption({ label: "bClient" });
    await dialog.locator("#acc-title").fill("bClient — Sklep Centrum");
    await dialog.locator("#acc-login").fill("zofia.bclient");

    // Generator: 8 znaków, wyłącznie małe litery i cyfry, max 3 cyfry.
    // Generator woła API asynchronicznie — czekamy na wartość, nie czytamy od razu.
    await dialog.locator("#acc-password").locator("..").getByTitle(/Wygeneruj hasło/).click();
    const passwordInput = dialog.locator("#acc-password");
    await expect(passwordInput).toHaveValue(/^[a-z0-9]{8}$/);
    const generated = await passwordInput.inputValue();
    expect((generated.match(/\d/g) ?? []).length).toBeLessThanOrEqual(3);
    expect((generated.match(/[a-z]/g) ?? []).length).toBeGreaterThanOrEqual(5);

    await dialog.getByRole("button", { name: "Dodaj dostęp" }).click();
    await expect(page.getByText("bClient — Sklep Centrum")).toBeVisible();
  });

  test("archiwizacja przenosi pracownika i pozwala przywrócić", async ({ page }) => {
    await page.goto("/pracownicy/1");
    page.once("dialog", (dialog) => void dialog.accept());
    await page.getByRole("button", { name: "Archiwizuj" }).click();

    await expect(page.getByText("archiwum", { exact: true })).toBeVisible();
    await expect(page.getByText(/Pracownik jest w archiwum/)).toBeVisible();

    await page.getByRole("button", { name: "Przywróć" }).click();
    await expect(page.getByText("aktywny", { exact: true })).toBeVisible();
  });

  test("historia zmian pokazuje wpisy bez wartości haseł", async ({ page }) => {
    await page.goto("/pracownicy/1");
    await page.getByRole("button", { name: "Pokaż", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Historia zmian" })).toBeVisible();
    // Historia istnieje (seed utworzył rekordy) albo jest pusta — nigdy z hasłem.
    await expect(page.getByText(SECRET_PASSWORD)).toHaveCount(0);
  });

  test("eksport danych pracownika zwraca plik JSON", async ({ page }) => {
    const response = await page.request.get("/api/workers/1/export");
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { nazwisko: string; dostepy: unknown[] };
    expect(body.nazwisko).toBe("Żółkiewska");
    expect(Array.isArray(body.dostepy)).toBe(true);

    // Nazwa pliku z polskimi znakami nie może wywalić nagłówka (regresja 500).
    const disposition = response.headers()["content-disposition"];
    expect(disposition).toContain('filename="pracownik-Zolkiewska-Zofia.json"');
    expect(disposition).toContain("filename*=UTF-8''");
    // Eksport RODO nie może zawierać hasła w cleartext.
    expect(JSON.stringify(body)).not.toContain(SECRET_PASSWORD);
  });
});
