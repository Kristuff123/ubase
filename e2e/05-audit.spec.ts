import { expect, test } from "./fixtures";
import { login } from "./helpers";

/**
 * Audyt: log zdarzeń, weryfikacja łańcucha hash i eksport CSV.
 *
 * Sedno systemu dowodowego — łańcuch musi być weryfikowalny jednym kliknięciem,
 * a eksport musi być poprawnym CSV z BOM (Excel w polskiej lokalizacji otwiera
 * plik bez BOM jako krzaki, więc to nie kosmetyka).
 */
test.describe("audyt", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "admin");
    await page.goto("/audyt");
  });

  test("pokazuje zdarzenia i filtry", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Audyt" })).toBeVisible();

    // Seed zapisuje zdarzenie systemowe, a logowanie dopisuje własne wpisy.
    await expect(page.getByRole("cell", { name: /Logowanie/ }).first()).toBeVisible();
    await expect(page.getByRole("option", { name: /Wszystkie akcje \(\d+\)/ })).toBeAttached();

    // Licznik w stopce mówi, ile wierszy widać.
    await expect(page.getByText(/Pokazano \d+ z \d+ wczytanych zdarzeń/)).toBeVisible();
  });

  test("weryfikacja integralności przechodzi na zdrowym łańcuchu", async ({ page }) => {
    await page.getByRole("button", { name: "Sprawdź integralność" }).click();

    // Baner wyniku (nie toast — oba mają podobny tekst).
    await expect(page.locator("div", { hasText: /^Łańcuch poprawny — \d+ wpisów, brak luk i podmian\.$/ })).toBeVisible({
      timeout: 15_000,
    });
    // Samo sprawdzenie też jest zdarzeniem audytowym — dowód, że kontrola się odbyła.
    await expect(page.getByRole("cell", { name: /Weryfikacja audytu/ }).first()).toBeVisible();
  });

  test("wpis można rozwinąć i zobaczyć hashe", async ({ page }) => {
    const firstRow = page.locator("tbody tr").first();
    const sequenceCell = firstRow.locator("td").first();
    await expect(sequenceCell).toHaveText(/^\d+$/);
    const seq = await sequenceCell.innerText();
    await firstRow.click();

    // Rozwinięty wiersz pokazuje pełny hash wpisu i hash poprzedni.
    await expect(page.getByText("Hash wpisu")).toBeVisible();
    await expect(page.getByText("Hash poprzedni")).toBeVisible();
    const hashes = page.locator("dd.ub-mono.break-all");
    await expect(hashes).toHaveCount(2);
    // SHA-256 w hex = 64 znaki.
    for (const text of await hashes.allInnerTexts()) {
      expect(text).toMatch(/^[0-9a-f]{64}$/);
    }
    expect(seq).toMatch(/^\d+$/);
  });

  test("filtr po akcji zawęża listę", async ({ page }) => {
    const select = page.locator("select").first();
    // Etykiety opcji zawierają liczniki, np. „Logowanie (7)” — czytamy ją z DOM,
    // bo selectOption przyjmuje wyłącznie literały (bez regexpów).
    const option = select.locator("option", { hasText: /^Logowanie \(\d+\)$/ }).first();
    const label = (await option.innerText()).trim();
    await select.selectOption({ label });

    // Po filtrze wszystkie widoczne chipy to logowania.
    await expect(page.locator("tbody .ub-chip").first()).toHaveText("Logowanie");
    const chips = await page.locator("tbody .ub-chip").allInnerTexts();
    expect(chips.length).toBeGreaterThan(0);
    expect(chips.every((text) => text === "Logowanie")).toBe(true);
  });

  test("eksport CSV jest poprawnym plikiem z BOM i nagłówkiem", async ({ page }) => {
    const response = await page.request.get("/api/audit/export");
    expect(response.status()).toBe(200);

    const headers = response.headers();
    expect(headers["content-type"]).toContain("text/csv");
    expect(headers["content-disposition"]).toContain("audyt-");
    expect(headers["content-disposition"]).toContain(".csv");

    const buffer = await response.body();
    // BOM UTF-8 — bez niego Excel w polskiej lokalizacji psuje polskie znaki.
    expect(buffer.subarray(0, 3)).toEqual(Buffer.from([0xef, 0xbb, 0xbf]));

    const text = buffer.toString("utf8");
    const lines = text.replace(/^\uFEFF/, "").split("\r\n");
    expect(lines[0]).toBe("seq;czas;uzytkownik;ip;akcja;typ;id;opis;hash;poprzedni_hash");
    expect(lines.length).toBeGreaterThan(1);

    // Każdy wiersz danych ma 10 kolumn (średniki w opisach są cytowane).
    const dataLine = lines[1];
    let columns = 0;
    let quoted = false;
    for (const char of dataLine) {
      if (char === '"') quoted = !quoted;
      else if (char === ";" && !quoted) columns += 1;
    }
    expect(columns + 1).toBe(10);

    // Eksport nie może wynieść z systemu żadnego hasła.
    expect(text).not.toContain("tajne-haslo-axel");
  });

  test("eksport dopisuje własne zdarzenie audytowe", async ({ page }) => {
    await page.request.get("/api/audit/export");

    // Wpis jest najnowszy — sprawdzamy przez API z filtrem akcji, żeby nie
    // zależeć od kolejności i limitu 200 wierszy w tabeli.
    const response = await page.request.get("/api/audit?action=audit.exported&limit=5");
    const body = (await response.json()) as { events: { action: string; summary: string }[] };
    expect(body.events.length).toBeGreaterThan(0);
    expect(body.events[0].action).toBe("audit.exported");
    expect(body.events[0].summary).toMatch(/Wyeksportowano log audytowy/);
  });

  test("audytor ma dostęp do audytu i może weryfikować", async ({ page }) => {
    // Rola kontrolna musi mieć dostęp do własnego przedmiotu kontroli.
    await page.getByTitle("Wyloguj").click();
    await expect(page).toHaveURL(/\/login/);

    await login(page, "audytor");
    await page.goto("/audyt");
    await expect(page.getByRole("heading", { name: "Audyt" })).toBeVisible();

    await page.getByRole("button", { name: "Sprawdź integralność" }).click();
    await expect(
      page.locator("div", { hasText: /^Łańcuch poprawny — \d+ wpisów, brak luk i podmian\.$/ }),
    ).toBeVisible({ timeout: 15_000 });
  });
});
