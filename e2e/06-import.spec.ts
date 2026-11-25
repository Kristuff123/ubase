import { expect, test } from "./fixtures";
import { login, buildXlsx, unique } from "./helpers";

/**
 * Import z Excela — pełna ścieżka: upload .xlsx → mapowanie kolumn → podgląd
 * z rozwiązywaniem jednostek → zapis. Plik jest prawdziwym xlsx zbudowanym
 * przez ExcelJS (ta sama biblioteka, której używa serwer do parsowania).
 */
test.describe("import", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "admin");
    await page.goto("/import");
  });

  /** Wgrywa plik przez ukryty input i czeka na krok mapowania kolumn. */
  async function upload(page: import("@playwright/test").Page, buffer: Buffer, name = "lista.xlsx") {
    await page.locator('input[type="file"]').setInputFiles({
      name,
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer,
    });
    await expect(page.getByRole("heading", { name: "Dopasuj kolumny" })).toBeVisible({ timeout: 20_000 });
  }

  test("pełny import: mapowanie, podgląd i zapis", async ({ page }) => {
    const lastName = unique("Import");
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Stanowisko", "Sklep", "E-mail"],
      ["Grażyna", lastName, "cukiernik", "Sklep Centrum", "grazyna@firma.pl"],
      ["Tomasz", `${lastName}B`, "piekarz", "PIEKARNIA", "tomasz@firma.pl"],
    ]);

    await upload(page, buffer);

    // Heurystyka dopasowuje nagłówki automatycznie — operator tylko sprawdza.
    await expect(page.getByText(/Plik: lista.xlsx/)).toBeVisible();
    // Pięć dopasowanych kolumn = pięć list wyboru.
    await expect(page.locator("select")).toHaveCount(5);

    await page.getByRole("button", { name: "Pokaż podgląd" }).click();

    // Krok 3: statystyki i tabela wierszy.
    await expect(page.getByRole("heading", { name: "Podgląd wierszy" })).toBeVisible({ timeout: 20_000 });
    const stats = page.locator(".ub-card");
    await expect(stats.getByText("Wiersze", { exact: true })).toBeVisible();
    await expect(page.getByRole("cell", { name: new RegExp(`Grażyna ${lastName}`) })).toBeVisible();
    await expect(page.getByRole("cell", { name: new RegExp(`Tomasz ${lastName}B`) })).toBeVisible();

    // Przycisk pokazuje realną liczbę wierszy do zapisania.
    const commit = page.getByRole("button", { name: /Zaimportuj 2 osób/ });
    await expect(commit).toBeEnabled();
    await commit.click();

    // Krok 4: wynik.
    await expect(page.getByRole("heading", { name: "Import zakończony" })).toBeVisible({ timeout: 20_000 });
    await expect(page.getByText(/Dodano 2 osób, pominięto 0/)).toBeVisible();

    // Weryfikacja u źródła: osoby są w bazie i wyszukiwalne.
    await page.getByRole("link", { name: "Przejdź do listy" }).click();
    await page.getByLabel("Szukaj pracowników").fill(lastName.toLowerCase());
    // Lista renderuje „Nazwisko Imię" (tak jak papierowa kartoteka).
    await expect(page.getByRole("cell", { name: new RegExp(`${lastName} Grażyna`) })).toBeVisible();
  });

  test("nieznana jednostka trafia do decyzji, nie do bazy po cichu", async ({ page }) => {
    const lastName = unique("Sierota");
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Marcin", lastName, "Sklep Którego Nie Ma"],
    ]);

    await upload(page, buffer);
    await page.getByRole("button", { name: "Pokaż podgląd" }).click();

    await expect(page.getByText(/Nierozpoznane jednostki \(1\)/)).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(".ub-card").filter({ hasText: "Nierozpoznane jednostki" }).getByText("Sklep Którego Nie Ma")).toBeVisible();

    // Bez decyzji wiersz nie jest importowalny — przycisk blokuje zapis.
    const commit = page.getByRole("button", { name: /Zaimportuj 0 osób/ });
    await expect(commit).toBeDisabled();

    // Przypisanie do istniejącej jednostki odblokowuje import.
    await page
      .locator(".ub-card")
      .filter({ hasText: "Nierozpoznane jednostki" })
      .locator("select")
      .selectOption({ label: "Sklep Centrum" });
    await expect(page.getByRole("button", { name: /Zaimportuj 1 osób/ })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: /Zaimportuj 1 osób/ }).click();

    await expect(page.getByText(/Dodano 1 osobę, pominięto 0/)).toBeVisible({ timeout: 20_000 });
  });

  test("opcja tworzenia brakujących jednostek działa", async ({ page }) => {
    const lastName = unique("Nowysklep");
    const shop = unique("Sklep Testowy");
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Halina", lastName, shop],
    ]);

    await upload(page, buffer);
    await page.getByRole("button", { name: "Pokaż podgląd" }).click();
    await expect(page.getByText(/Nierozpoznane jednostki/)).toBeVisible({ timeout: 20_000 });

    await page.getByLabel("Utwórz brakujące jednostki jako sklepy").check();
    await expect(page.getByRole("button", { name: /Zaimportuj 1 osób/ })).toBeEnabled({ timeout: 20_000 });
    await page.getByRole("button", { name: /Zaimportuj 1 osób/ }).click();
    await expect(page.getByText(/Dodano 1 osobę/)).toBeVisible({ timeout: 20_000 });

    // Nowy sklep istnieje i jest typu sklep (nie zakład).
    const units = await page.request.get("/api/admin/org-units");
    const body = (await units.json()) as { units: { name: string; type: string }[] };
    const created = body.units.find((unit) => unit.name === shop);
    expect(created?.type).toBe("sklep");
  });

  test("błędne wiersze są pomijane, poprawne wchodzą", async ({ page }) => {
    const lastName = unique("Czesc");
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Zbigniew", lastName, "BISTRO"],
      // Brak nazwiska — wiersz nie może wejść, ale nie blokuje pozostałych.
      ["Bezimienny", "", "BISTRO"],
    ]);

    await upload(page, buffer);
    await page.getByRole("button", { name: "Pokaż podgląd" }).click();
    await expect(page.getByRole("heading", { name: "Podgląd wierszy" })).toBeVisible({ timeout: 20_000 });

    await expect(page.locator("tbody tr .ub-chip").filter({ hasText: /^błąd$/ })).toHaveCount(1);
    await expect(page.getByRole("button", { name: /Zaimportuj 1 osób/ })).toBeEnabled();
    await page.getByRole("button", { name: /Zaimportuj 1 osób/ }).click();

    await expect(page.getByText(/Dodano 1 osobę, pominięto 1/)).toBeVisible({ timeout: 20_000 });
  });

  test("istniejący pracownik jest oznaczony jako duplikat", async ({ page }) => {
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Zofia", "Żółkiewska", "PIEKARNIA"],
    ]);

    await upload(page, buffer);
    await page.getByRole("button", { name: "Pokaż podgląd" }).click();

    await expect(page.locator("tbody tr .ub-chip").filter({ hasText: /^duplikat$/ })).toHaveCount(1, { timeout: 20_000 });
    await expect(page.getByRole("button", { name: /Zaimportuj 0 osób/ })).toBeDisabled();
  });

  test("odrzuca plik inny niż .xlsx", async ({ page }) => {
    await page.locator('input[type="file"]').setInputFiles({
      name: "lista.csv",
      mimeType: "text/csv",
      buffer: Buffer.from("Imie;Nazwisko\nJan;Kowalski\n"),
    });
    await expect(page.getByText(/Dozwolone są wyłącznie pliki .xlsx/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dopasuj kolumny" })).toHaveCount(0);
  });

  test("kreator pozwala wrócić i wybrać inny plik", async ({ page }) => {
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Robert", unique("Powrot"), "BISTRO"],
    ]);
    await upload(page, buffer);

    await page.getByRole("button", { name: "Wstecz" }).click();
    await expect(page.getByText(/Przeciągnij plik .xlsx/)).toBeVisible();
    await expect(page.getByRole("heading", { name: "Dopasuj kolumny" })).toHaveCount(0);
  });

  test("import jest zapisany w audycie", async ({ page }) => {
    const lastName = unique("Audytowany");
    const buffer = await buildXlsx([
      ["Imię", "Nazwisko", "Sklep"],
      ["Wanda", lastName, "DESERÓWKA"],
    ]);

    await upload(page, buffer);
    await page.getByRole("button", { name: "Pokaż podgląd" }).click();
    await expect(page.getByRole("heading", { name: "Podgląd wierszy" })).toBeVisible({ timeout: 20_000 });
    await page.getByRole("button", { name: /Zaimportuj 1 osób/ }).click();
    await expect(page.getByText(/Dodano 1 osobę/)).toBeVisible({ timeout: 20_000 });

    await page.goto("/audyt");
    await expect(page.getByRole("cell", { name: /Import wykonany/ }).first()).toBeVisible();
    await expect(page.getByRole("cell", { name: /Podgląd importu/ }).first()).toBeVisible();
  });
});
