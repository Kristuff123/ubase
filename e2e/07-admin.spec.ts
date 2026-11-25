import { expect, test } from "./fixtures";
import { login, newClientContext, restoreAccounts, unique } from "./helpers";

/** Wartość ciasteczka `ub_csrf` — potrzebna do żądań zapisu z `page.request`. */
async function csrfFromCookie(page: import("@playwright/test").Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.find((cookie) => cookie.name === "ub_csrf")?.value ?? "";
}

async function cookieHeader(page: import("@playwright/test").Page): Promise<string> {
  const cookies = await page.context().cookies();
  return cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
}

/**
 * Administracja: konta aplikacji (twardy limit 5), jednostki organizacyjne,
 * kategorie dostępów i klucze szyfrowania.
 *
 * Seed tworzy 5 aktywnych kont (admin, operator, audytor, dwaefa, blokada),
 * czyli dokładnie tyle, ile przewiduje limit — dzięki temu test graniczny
 * „piąte konto blokuje szóste" działa bez przygotowywania danych.
 */
test.describe("administracja", () => {
  test.beforeEach(async ({ page }) => {
    await login(page, "admin");
    // Każdy test startuje od stanu seeda: testy tworzą i wyłączają konta,
    // a limitu pięciu aktywnych nie da się obejść. Bez tego jedna porażka
    // (np. przerwany test przed sprzątaniem) kaskaduje na cały przebieg.
    await restoreAccounts(page);
    await page.goto("/administracja");
  });

  test.afterEach(async ({ page }) => {
    await restoreAccounts(page);
  });

  test("pokazuje zakładki i licznik kont", async ({ page }) => {
    await expect(page.getByRole("heading", { name: "Administracja" })).toBeVisible();
    await expect(page.getByRole("button", { name: /Konta \(5\/5\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Jednostki \(\d+\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: /Kategorie \(\d+\)/ })).toBeVisible();
    await expect(page.getByRole("button", { name: "Klucze" })).toBeVisible();
  });

  test("lista kont pokazuje role i status 2FA", async ({ page }) => {
    // Nazwa wyświetlana pojawia się też w nagłówku aplikacji — celujemy w tabelę kont.
    await expect(page.locator("tbody tr").filter({ hasText: "Anna Admin" })).toBeVisible();
    await expect(page.getByRole("cell", { name: /admin/ }).first()).toBeVisible();
    // Konto dwaefa ma 2FA z seeda, pozostałe nie — liczymy tylko chipy w tabeli.
    const table = page.locator("table");
    await expect(table.locator(".ub-chip", { hasText: "włączone" })).toHaveCount(1);
    await expect(table.locator(".ub-chip", { hasText: "brak" })).toHaveCount(4);
  });

  test("limit pięciu kont blokuje utworzenie szóstego", async ({ page }) => {
    // Przy 5/5 UI nie pokazuje nawet linku „Dodaj konto"…
    await expect(page.getByRole("button", { name: "Dodaj konto" })).toHaveCount(0);
    await expect(page.getByText("Aktywne konta: 5 z 5 przewidzianych.")).toBeVisible();

    // …a API egzekwuje limit niezależnie od UI.
    const response = await page.request.post("/api/admin/users", {
      headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
      data: { username: unique("szoste"), displayName: "Szóste Konto", role: "operator" },
    });
    expect(response.status()).toBe(409);
    const body = (await response.json()) as { code: string };
    expect(body.code).toBe("user_limit");
  });

  test("wyłączenie konta zwalnia miejsce i pozwala dodać nowe", async ({ page }) => {
    // Wyłączamy konto `audytor` (nie jest adminem, więc operacja przechodzi).
    const row = page.getByRole("row", { name: /audytor/ });
    page.once("dialog", (dialog) => void dialog.accept());
    await row.getByRole("button", { name: "wyłącz" }).click();

    await expect(page.getByRole("button", { name: /Konta \(4\/5\)/ })).toBeVisible({ timeout: 15_000 });

    // Teraz UI odsłania formularz nowego konta.
    await page.getByRole("button", { name: "Dodaj konto" }).click();
    const username = unique("nowy");
    await page.locator("#nu-login").fill(username);
    await page.locator("#nu-name").fill("Nowy Operator");
    await page.locator("#nu-role").selectOption({ label: "Operator" });
    await page.getByRole("button", { name: "Utwórz konto" }).click();

    // Hasło startowe jest pokazywane raz — musi być widoczne i mieć sensowną długość.
    await expect(page.getByText(/Hasło startowe/)).toBeVisible({ timeout: 15_000 });
    const password = await page.locator(".ub-mono.text-\\[16px\\]").innerText();
    expect(password.length).toBeGreaterThanOrEqual(12);
    await expect(page.getByText("Konto wymusi zmianę hasła przy pierwszym logowaniu.")).toBeVisible();

    // Nowe konto pojawia się na liście i licznik wraca do 5/5.
    await expect(page.getByRole("button", { name: /Konta \(5\/5\)/ })).toBeVisible({ timeout: 15_000 });
    await expect(page.getByRole("cell", { name: new RegExp(username) })).toBeVisible();
  });

  test("nowe konto musi zmienić hasło przy pierwszym logowaniu", async ({ page, context, clientIp }) => {
    // Zwolnij miejsce i utwórz konto przez API (szybciej niż przez formularz).
    const users = await page.request.get("/api/admin/users");
    const list = (await users.json()) as { users: { id: number; username: string }[] };
    const audytor = list.users.find((user) => user.username === "audytor")!;
    const disabled = await page.request.patch(`/api/admin/users/${audytor.id}`, {
      headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
      data: { isActive: false },
    });
    expect(disabled.ok(), "wyłączenie audytora zwalnia miejsce dla konta testowego").toBeTruthy();

    const username = unique("pierwszy");
    const created = await page.request.post("/api/admin/users", {
      headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
      data: { username, displayName: "Pierwsze Logowanie", role: "operator" },
    });
    const createdBody = (await created.json()) as { password?: string; error?: string; code?: string };
    expect(created.status(), `utworzenie konta: ${createdBody.error ?? "ok"}`).toBe(201);
    const password = createdBody.password!;

    // Logujemy się w osobnym kontekście — nie chcemy wylogować admina.
    const fresh = await newClientContext(context.browser()!, clientIp, 1);
    const other = await fresh.newPage();
    await other.goto("/login");
    await other.getByLabel("Login").fill(username);
    await other.getByLabel("Hasło", { exact: true }).fill(password);
    await other.getByRole("button", { name: "Zaloguj się" }).click();

    await expect(other.getByRole("heading", { name: "Zmiana hasła wymagana" })).toBeVisible({ timeout: 15_000 });

    const newPassword = "Nowe-Bardzo-Dlugie-2026!";
    await other.locator("#cur").fill(password);
    await other.locator("#new").fill(newPassword);
    await other.locator("#rep").fill(newPassword);
    await other.getByRole("button", { name: "Ustaw hasło" }).click();

    // Po ustawieniu hasła sesja działa i widzi listę.
    await expect(other.getByRole("heading", { name: "Pracownicy" })).toBeVisible({ timeout: 20_000 });
    await fresh.close();

    // Sprzątanie: przywracamy konto audytora i wyłączamy konto testowe,
    // żeby kolejne testy widziały znowu pięć kont seedowych (afterEach robi
    // to samo, ale jawne sprzątanie trzyma test czytelnym).
    await page.request.patch(`/api/admin/users/${audytor.id}`, {
      headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
      data: { isActive: true },
    });
    const created2 = (await (await page.request.get("/api/admin/users")).json()) as {
      users: { id: number; username: string }[];
    };
    const testAccount = created2.users.find((user) => user.username === username);
    if (testAccount) {
      await page.request.patch(`/api/admin/users/${testAccount.id}`, {
        headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
        data: { isActive: false },
      });
    }
  });

  test("zakładka jednostek pokazuje strukturę firmy", async ({ page }) => {
    await page.getByRole("button", { name: /Jednostki/ }).click();

    // Seed zawiera 3 regiony, 6 zakładów, 2 sklepy i biuro.
    await expect(page.getByText("Regiony")).toBeVisible();
    await expect(page.getByText("Zakłady")).toBeVisible();
    await expect(page.getByText("PIEKARNIA")).toBeVisible();
    await expect(page.getByText("Mazowiecki")).toBeVisible();

    // Filtr działa.
    await page.getByLabel("Filtruj jednostki").fill("pomorski");
    // Filtr zawęża wszystkie cztery grupy naraz — sprawdzamy, że została choć
    // jedna pozycja z „Pomorski" i że zniknęły zakłady.
    await expect(page.getByText(/Pomorski/).first()).toBeVisible();
    await expect(page.getByText("PIEKARNIA")).toHaveCount(0);
  });

  test("dodanie nowej jednostki", async ({ page }) => {
    await page.getByRole("button", { name: /Jednostki/ }).click();
    const shop = unique("Sklep Nowy");
    await page.getByLabel("Nazwa jednostki").fill(shop);
    await page.getByLabel("Numer").fill("999");
    await page.getByRole("button", { name: "Dodaj", exact: true }).click();

    await expect(page.getByText("Jednostka dodana")).toBeVisible({ timeout: 15_000 });
    await expect(page.getByText(`999`).first()).toBeVisible();
    await expect(page.getByText(shop)).toBeVisible();
  });

  test("zakładka kategorii pokazuje pola i pozwala wyłączyć kategorię", async ({ page }) => {
    await page.getByRole("button", { name: /Kategorie/ }).click();

    // Kategoria „Chip" ma zdefiniowane pola; administracja pokazuje ich etykiety
    // (wartości opcji poziomu dostępu żyją w JSON-ie definicji, nie w tym widoku).
    await expect(page.getByLabel("Nazwa kategorii chip")).toBeVisible();
    const chipCard = page.locator(".ub-card", { has: page.getByLabel("Nazwa kategorii chip") });
    await expect(chipCard.getByText("Numer chipa")).toBeVisible();
    await expect(chipCard.getByText("Poziom dostępu")).toBeVisible();
    await expect(chipCard.getByText("Data wydania")).toBeVisible();

    // Wyłączenie kategorii „Inne" nie usuwa istniejących wpisów, tylko ukrywa ją w formularzu.
    const inneCard = page.locator(".ub-card", { has: page.getByLabel("Nazwa kategorii inne") });
    await inneCard.getByRole("button", { name: "wyłącz" }).click();
    await expect(page.getByText("Kategoria wyłączona")).toBeVisible({ timeout: 15_000 });

    // Przywracamy, żeby stan bazy był przewidywalny po testach.
    await inneCard.getByRole("button", { name: "włącz" }).click();
    await expect(page.getByText("Kategoria włączona")).toBeVisible({ timeout: 15_000 });
  });

  test("zakładka kluczy pokazuje wersję DEK i ostrzeżenie o KEK", async ({ page }) => {
    await page.getByRole("button", { name: "Klucze" }).click();

    await expect(page.getByText("Szyfrowanie kopertowe")).toBeVisible();
    await expect(page.getByText(/Utrata KEK oznacza bezpowrotną utratę wszystkich sekretów/)).toBeVisible();
    await expect(page.getByRole("cell", { name: "v1" })).toBeVisible();
    await expect(page.getByText("aktywny")).toBeVisible();
  });

  test("reset hasła przez administratora wymusza zmianę przy logowaniu", async ({ page, clientIp }) => {
    const users = await page.request.get("/api/admin/users");
    const list = (await users.json()) as { users: { id: number; username: string }[] };
    const target = list.users.find((user) => user.username === "operator")!;

    const response = await page.request.patch(`/api/admin/users/${target.id}`, {
      headers: { "X-CSRF-Token": await csrfFromCookie(page), Cookie: await cookieHeader(page) },
      data: { resetPassword: true },
    });
    expect(response.status()).toBe(200);
    const body = (await response.json()) as { password: string };
    expect(body.password).toHaveLength(16);

    // Zresetowane hasło nie działa od razu jako pełny dostęp — konto musi je zmienić.
    const other = await (await newClientContext(page.context().browser()!, clientIp, 2)).newPage();
    await other.goto("/login");
    await other.getByLabel("Login").fill("operator");
    await other.getByLabel("Hasło", { exact: true }).fill(body.password);
    await other.getByRole("button", { name: "Zaloguj się" }).click();
    await expect(other.getByRole("heading", { name: "Zmiana hasła wymagana" })).toBeVisible({ timeout: 15_000 });

    // Przywracamy znane hasło operatora, żeby inne pliki specy działały.
    await other.locator("#cur").fill(body.password);
    await other.locator("#new").fill("Operator-Haslo-2026!");
    await other.locator("#rep").fill("Operator-Haslo-2026!");
    await other.getByRole("button", { name: "Ustaw hasło" }).click();
    await expect(other.getByRole("heading", { name: "Pracownicy" })).toBeVisible({ timeout: 20_000 });
    await other.context().close();
  });
});
