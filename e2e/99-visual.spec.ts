/**
 * Przegląd wizualny — zrzuty ekranu kluczowych widoków + automatyczne bramki wyglądu.
 *
 * Ten spec nie testuje zachowania (to robią pliki 01–08). Ma dwa zadania:
 *  1. wygenerować zrzuty do oceny kompozycji i hierarchii (`e2e/.visual/`),
 *  2. pilnować dwóch rzeczy, których nie wychwyci żaden test funkcjonalny:
 *     braku poziomego przewijania oraz kontrastu inicjałów awatara (WCAG AA).
 *
 * Uruchamianie:
 *   npx playwright test e2e/99-visual.spec.ts
 * Zrzuty trafiają do `e2e/.visual/` (ignorowane przez git).
 *
 * Dane demonstracyjne powstają przez API, nie przez UI — dzięki temu zrzuty pokazują
 * realistycznie zapełnione ekrany (kilkunastu pracowników, różne kategorie dostępów,
 * zdarzenia audytu), a nie pusty stan z jednym rekordem z seeda. Seed jest
 * **idempotentny**: cztery testy wołają go na tej samej bazie, więc bez sprawdzania
 * stanu lista pracowników rosłaby o 14 wierszy przy każdym wywołaniu.
 */
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "./fixtures";
import { login } from "./helpers";

const OUT = path.join(process.cwd(), "e2e", ".visual");

/** Miejsce na zrzuty — czyścimy raz na przebieg. */
test.beforeAll(() => {
  fs.rmSync(OUT, { recursive: true, force: true });
  fs.mkdirSync(OUT, { recursive: true });
});

async function shot(page: import("@playwright/test").Page, name: string, opts: { full?: boolean } = {}) {
  // Czekamy na koniec animacji wejścia kart, żeby zrzut nie złapał przezroczystości.
  await page.waitForTimeout(400);
  await page.screenshot({
    path: path.join(OUT, `${name}.png`),
    fullPage: opts.full ?? true,
    animations: "disabled",
  });
}

/** Nagłówki z ciasteczkami sesji — `page.request` nie dokłada ich sam. */
async function sessionHeaders(page: import("@playwright/test").Page) {
  const cookies = await page.context().cookies();
  const csrf = cookies.find((cookie) => cookie.name === "ub_csrf")?.value ?? "";
  return {
    "X-CSRF-Token": csrf,
    Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
  };
}

/**
 * Realistyczny zestaw danych: 14 pracowników w różnych jednostkach, z dostępami
 * w kilku kategoriach. Tworzone przez API na sesji admina — szybko i bez kruchości
 * selektorów.
 *
 * Idempotencja jest tu wymagana, a nie miła: cztery testy wołają tę funkcję, a jeden
 * z nich (motyw jasny) robi zrzut całej listy. Duplikaty widać wtedy na obrazku
 * jako ten sam człowiek trzy razy — dokładnie tak, jak wyglądał pierwszy przegląd.
 */
async function seedDemoData(page: import("@playwright/test").Page) {
  const headers = await sessionHeaders(page);

  const units = (await (await page.request.get("/api/admin/org-units")).json()) as {
    units: { id: number; name: string; type: string }[];
  };
  const unitId = (name: string) => units.units.find((unit) => unit.name === name)?.id ?? null;
  const catalog = (await (await page.request.get("/api/catalog")).json()) as {
    categories: { id: number; slug: string; name: string }[];
  };
  const categoryId = (slug: string) => catalog.categories.find((category) => category.slug === slug)?.id;

  const people: { first: string; last: string; position: string; unit: string; email?: string; phone?: string }[] = [
    { first: "Zofia", last: "Żółkiewska", position: "kierownik zmiany", unit: "PIEKARNIA", email: "zofia.zolkiewska@firma.pl", phone: "600 100 200" },
    { first: "Tomasz", last: "Wójcik", position: "piekarz", unit: "PIEKARNIA", email: "tomasz.wojcik@firma.pl" },
    { first: "Grażyna", last: "Nowakowska", position: "cukiernik", unit: "CUKIERNIA", email: "grazyna.nowakowska@firma.pl", phone: "601 300 400" },
    { first: "Michał", last: "Kaczmarek", position: "kierownik sklepu", unit: "Sklep Centrum", email: "michal.kaczmarek@firma.pl", phone: "602 500 600" },
    { first: "Agnieszka", last: "Lewandowska", position: "sprzedawca", unit: "Sklep Centrum" },
    { first: "Paweł", last: "Zieliński", position: "kierownik zakładu", unit: "BISTRO", email: "pawel.zielinski@firma.pl" },
    { first: "Katarzyna", last: "Szymańska", position: "brygadzista", unit: "PIEROGARNIA" },
    { first: "Robert", last: "Dąbrowski", position: "technik utrzymania ruchu", unit: "PIEKARNIA", phone: "603 700 800" },
    { first: "Monika", last: "Kozłowska", position: "specjalista ds. kadr", unit: "ADMINISTRACJA", email: "monika.kozlowska@firma.pl" },
    { first: "Łukasz", last: "Jankowski", position: "kierownik regionalny", unit: "Biuro Warszawa", email: "lukasz.jankowski@firma.pl", phone: "604 900 100" },
    { first: "Ewa", last: "Mazur", position: "cukiernik", unit: "DESERÓWKA" },
    { first: "Damian", last: "Krawczyk", position: "sprzedawca", unit: "Sklep Gdańsk Główna" },
    { first: "Sylwia", last: "Piotrowska", position: "analityk", unit: "ADMINISTRACJA", email: "sylwia.piotrowska@firma.pl" },
    { first: "Grzegorz", last: "Grabowski", position: "piekarz", unit: "PIEKARNIA" },
  ];

  // Stan wyjściowy: kto już jest w bazie. Bez tego `POST` z `force: true` zaśmiecał
  // listę kopiami, a bez `force` zwracałby 409 i nie mielibyśmy id do dostępów.
  const list = (await (
    await page.request.get("/api/workers?status=wszyscy&limit=200")
  ).json()) as { items: { id: number; firstName: string; lastName: string }[] };
  const byName = new Map(list.items.map((item) => [`${item.lastName}|${item.firstName}`, item.id]));

  for (const person of people) {
    const key = `${person.last}|${person.first}`;
    if (byName.has(key)) continue;
    const response = await page.request.post("/api/workers", {
      headers,
      data: {
        firstName: person.first,
        lastName: person.last,
        position: person.position,
        orgUnitId: unitId(person.unit),
        email: person.email ?? null,
        phone: person.phone ?? null,
      },
    });
    // 409 = ktoś zdążył dodać tę samą osobę; wtedy po prostu nie tworzymy drugiej.
    if (response.status() !== 201) continue;
    const body = (await response.json()) as { id: number };
    byName.set(key, body.id);
  }

  const pick = (last: string) => {
    const person = people.find((p) => p.last === last);
    return person ? byName.get(`${last}|${person.first}`) : undefined;
  };

  // Dostępy też muszą być idempotentne — inaczej powtórzony przebieg zamienia
  // „Chip” w „Chip ×3”, co wygląda jak defekt produktu, a jest defektem seeda.
  // Tytuły istniejących dostępów czytamy z kartoteki (`GET /api/workers/:id`);
  // endpoint `…/accesses` obsługuje wyłącznie POST, więc nie ma tam czego czytać.
  const existingAccesses = new Map<number, Set<string>>();
  const titlesFor = async (workerId: number) => {
    const cached = existingAccesses.get(workerId);
    if (cached) return cached;
    const response = await page.request.get(`/api/workers/${workerId}`, { headers });
    const body = response.ok()
      ? ((await response.json()) as { accesses: { title: string }[] })
      : { accesses: [] };
    const titles = new Set(body.accesses.map((access) => access.title));
    existingAccesses.set(workerId, titles);
    return titles;
  };

  const access = async (last: string, slug: string, values: Record<string, string | string[]>, title: string) => {
    const workerId = pick(last);
    const category = categoryId(slug);
    if (!workerId || !category) return;
    if ((await titlesFor(workerId)).has(title)) return;
    await page.request.post(`/api/workers/${workerId}/accesses`, {
      headers,
      data: { categoryId: category, title, resourceOwner: "firma", values },
    });
  };

  await access("Żółkiewska", "axel", { login: "zofia.piekarnia", password: "tajne-haslo-axel-123" }, "Axel — piekarnia");
  await access("Żółkiewska", "chip", { number: "00412", level: ["piekarnia", "alarm"], issued_at: "2026-01-15" }, "Chip — wejście główne");
  await access("Wójcik", "axel", { login: "tomasz.piekarnia", password: "tajne-haslo-axel-456" }, "Axel — piekarnia");
  await access("Wójcik", "chip", { number: "00413", level: ["piekarnia"], issued_at: "2026-02-01" }, "Chip — hala");
  await access("Kaczmarek", "bclient", { login: "michal.centrum", password: "bclient-haslo-1", store: "Sklep Centrum" }, "bClient — Centrum");
  await access("Kaczmarek", "monitoring", { scope: "zaklad", zaklad: "BISTRO", login: "michal.mon" }, "Monitoring — podgląd");
  await access("Lewandowska", "bclient", { login: "aga.centrum", password: "bclient-haslo-2", store: "Sklep Centrum" }, "bClient — Centrum");
  await access("Zieliński", "remote", { method: "VPN", login: "pawel.z", password: "vpn-haslo-1" }, "VPN — zdalny");
  await access("Szymańska", "chip", { number: "00501", level: ["pierogarnia", "biura"], issued_at: "2026-03-04" }, "Chip — pierogarnia");
  await access("Kozłowska", "poczta", { account_type: "firmowe", address: "monika.kozlowska@firma.pl", password: "poczta-haslo-1" }, "Poczta firmowa");
  await access("Kozłowska", "google", { account_type: "firmowe", address: "monika.kozlowska@firma.pl", password: "google-haslo-1" }, "Google Workspace");
  await access("Jankowski", "monitoring", { scope: "wszystkie", login: "lukasz.mon" }, "Monitoring — wszystkie");
  await access("Jankowski", "remote", { method: "RDP", login: "lukasz.rdp", password: "rdp-haslo-1" }, "RDP — serwer");
  await access("Dąbrowski", "chip", { number: "00420", level: ["piekarnia", "cukiernia", "alarm"], issued_at: "2026-01-20" }, "Chip — pełny dostęp");
  await access("Mazur", "axel", { login: "ewa.deserowka", password: "tajne-haslo-axel-789" }, "Axel — deserówka");
}

/**
 * Bramka układu: strona nie może przewijać się w poziomie.
 *
 * Tabela z pięcioma kolumnami i długimi opisami potrafi wypchnąć kartę poza ekran —
 * wtedy ostatnia kolumna (hash) staje się niewidoczna bez przewijania na boki.
 * Jeden piksel tolerancji na zaokrąglenia subpikselowe.
 */
async function expectNoHorizontalOverflow(page: import("@playwright/test").Page, label: string) {
  const overflow = await page.evaluate(() => {
    const root = document.documentElement;
    return { scrollWidth: root.scrollWidth, clientWidth: root.clientWidth };
  });
  expect(
    overflow.scrollWidth,
    `${label}: treść (${overflow.scrollWidth}px) szersza niż ekran (${overflow.clientWidth}px) — poziomy pasek przewijania`,
  ).toBeLessThanOrEqual(overflow.clientWidth + 1);
}

/**
 * Bramka kontrastu: inicjały w awatarze muszą mieć ≥ 4.5:1 (WCAG AA, tekst mały).
 *
 * Liczymy na realnym tle: awatar ma półprzezroczyste tło (`--ub-accent-soft`),
 * więc kolor trzeba złożyć z tłem karty, zanim policzy się luminancję. W motywie
 * jasnym akcent `#b87800` na 10% tła dawał 3.29:1 — poniżej progu.
 */
async function avatarContrast(page: import("@playwright/test").Page): Promise<number> {
  return page.evaluate(() => {
    const parse = (value: string): [number, number, number, number] => {
      const numbers = value.match(/[\d.]+/g)?.map(Number) ?? [];
      return [numbers[0] ?? 0, numbers[1] ?? 0, numbers[2] ?? 0, numbers[3] ?? 1];
    };
    const composite = (top: [number, number, number, number], bottom: [number, number, number]) =>
      top.slice(0, 3).map((channel, index) => channel * top[3] + bottom[index] * (1 - top[3])) as [number, number, number];
    const luminance = (rgb: [number, number, number]) => {
      const [r, g, b] = rgb.map((channel) => {
        const c = channel / 255;
        return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };

    const badge = document.querySelector("tbody span.rounded-full");
    if (!badge) throw new Error("Nie znaleziono awatara w tabeli pracowników");

    const style = getComputedStyle(badge);
    const foreground = parse(style.color);

    // Tło awatara jest półprzezroczyste — schodzimy w górę drzewa, aż znajdziemy
    // nieprzezroczysty kolor (karta), i dopiero wtedy składamy warstwy.
    let background: [number, number, number] = [11, 13, 18];
    let node: HTMLElement | null = badge as HTMLElement;
    const layers: [number, number, number, number][] = [];
    while (node) {
      const layer = parse(getComputedStyle(node).backgroundColor);
      if (layer[3] > 0) {
        layers.push(layer);
        if (layer[3] >= 1) break;
      }
      node = node.parentElement;
    }
    for (const layer of layers.reverse()) background = composite(layer, background);

    const lighter = Math.max(luminance(background), luminance(foreground.slice(0, 3) as [number, number, number]));
    const darker = Math.min(luminance(background), luminance(foreground.slice(0, 3) as [number, number, number]));
    return (lighter + 0.05) / (darker + 0.05);
  });
}

test.describe("przegląd wizualny", () => {
  test("logowanie", async ({ page }) => {
    await page.goto("/login");
    await expect(page.getByRole("button", { name: "Zaloguj się" })).toBeVisible();
    await shot(page, "01-login", { full: false });
    await expectNoHorizontalOverflow(page, "logowanie");
  });

  test("lista pracowników z danymi", async ({ page }) => {
    await login(page, "admin");
    await seedDemoData(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();

    // Seed jest idempotentny: każda osoba dokładnie raz, mimo czterech wywołań na przebieg.
    const names = await page.locator("tbody tr td:first-child a").allInnerTexts();
    const repeated = names.filter((name, index) => names.indexOf(name) !== index);
    expect(repeated, "seed powtórzył pracowników").toEqual([]);

    expect(await avatarContrast(page)).toBeGreaterThanOrEqual(4.5);
    await shot(page, "02-lista-pracownikow");
    await expectNoHorizontalOverflow(page, "lista pracowników");
  });

  test("kartoteka pracownika z dostępami", async ({ page }) => {
    await login(page, "admin");
    await seedDemoData(page);
    await page.goto("/");
    await page.getByLabel("Szukaj pracowników").fill("żółkiewska");
    await page.getByRole("link", { name: /Żółkiewska/ }).first().click();
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
    await shot(page, "03-kartoteka-pracownika");
    await expectNoHorizontalOverflow(page, "kartoteka pracownika");
  });

  test("audyt", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/audyt");
    await expect(page.getByRole("heading", { name: /Audyt/i })).toBeVisible();
    // Filtry daty muszą być opisane słowami — dwa identyczne puste pola z ikoną
    // kalendarza nie mówią, które jest „od", a które „do".
    await expect(page.getByLabel("Od", { exact: true })).toBeVisible();
    await expect(page.getByLabel("Do", { exact: true })).toBeVisible();
    await shot(page, "04-audyt");
    await expectNoHorizontalOverflow(page, "audyt");
  });

  test("import — krok mapowania", async ({ page }) => {
    await login(page, "operator");
    await page.goto("/import");
    await expect(page.getByRole("heading", { name: /Import/i })).toBeVisible();
    await shot(page, "05-import-start");
    await expectNoHorizontalOverflow(page, "import");
  });

  test("administracja — konta", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/administracja");
    await expect(page.getByRole("heading", { name: "Administracja" })).toBeVisible();
    await shot(page, "06-administracja-konta");
    await expectNoHorizontalOverflow(page, "administracja — konta");
  });

  test("administracja — jednostki", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/administracja");
    await page.getByRole("button", { name: /Jednostki/ }).click();
    await expect(page.getByLabel("Filtruj jednostki")).toBeVisible();
    await shot(page, "07-administracja-jednostki");
    await expectNoHorizontalOverflow(page, "administracja — jednostki");
  });

  test("moje konto", async ({ page }) => {
    await login(page, "admin");
    await page.goto("/konto");
    await expect(page.getByRole("heading", { name: "Moje konto" })).toBeVisible();
    await shot(page, "08-moje-konto");
    await expectNoHorizontalOverflow(page, "moje konto");
  });

  test("motyw jasny — lista pracowników", async ({ page }) => {
    // Motyw ustawiamy przed nawigacją, żeby zrzut nie złapał mignięcia ciemnego tła.
    await page.addInitScript(() => window.localStorage.setItem("ub-theme", "light"));
    await login(page, "admin");
    await seedDemoData(page);
    await page.goto("/");
    await expect(page.getByRole("heading", { name: "Pracownicy" })).toBeVisible();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");

    // Ten sam awatar, inny zestaw tokenów — kontrast trzeba sprawdzić osobno.
    expect(await avatarContrast(page)).toBeGreaterThanOrEqual(4.5);
    await shot(page, "09-lista-motyw-jasny");
    await expectNoHorizontalOverflow(page, "lista pracowników (motyw jasny)");
  });

  test("widok mobilny — lista pracowników", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await login(page, "admin");
    await seedDemoData(page);
    const created = await page.request.post("/api/workers", {
      headers: await sessionHeaders(page),
      data: { firstName: "Aleksandra-Małgorzata", lastName: "Kowalska-Nowakowska" },
    });
    expect(created.status()).toBe(201);
    await page.goto("/");
    await expect(page.getByRole("link", { name: /Kowalska-Nowakowska/ })).toBeVisible();
    const tableFrame = page.locator(".ub-card").filter({ has: page.locator("table") });
    const widths = await tableFrame.evaluate((element) => ({
      content: element.scrollWidth,
      visible: element.clientWidth,
    }));
    expect(widths.content, "Długa nazwa pracownika wypycha kolumnę dostępów poza kartę").toBeLessThanOrEqual(widths.visible + 1);
    // Telefon pokazuje rzeczywisty viewport razem ze stałą dolną nawigacją.
    await shot(page, "10-lista-mobile", { full: false });
    await expectNoHorizontalOverflow(page, "lista pracowników (mobile)");
  });
});
