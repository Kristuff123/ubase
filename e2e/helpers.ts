/**
 * Helpery E2E: logowanie przez UI i API, liczenie kodów TOTP, generowanie .xlsx.
 *
 * Zasada: testy przechodzą przez prawdziwy UI tam, gdzie badają UX. Pomocnicze
 * operacje (np. przygotowanie danych) mogą iść przez API — szybciej i stabilniej.
 */
import { expect, type Page, type APIRequestContext } from "@playwright/test";
import { createHmac } from "node:crypto";
import ExcelJS from "exceljs";
import { ACCOUNTS } from "./seed.mjs";

export { ACCOUNTS };

export type Role = keyof typeof ACCOUNTS;

const BASE32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function base32Decode(input: string): Buffer {
  const clean = input.replace(/=+$/g, "").toUpperCase().replace(/\s+/g, "");
  let bits = 0;
  let value = 0;
  const bytes: number[] = [];
  for (const char of clean) {
    const idx = BASE32.indexOf(char);
    if (idx === -1) throw new Error(`Nieprawidłowy znak base32: ${char}`);
    value = (value << 5) | idx;
    bits += 5;
    if (bits >= 8) {
      bytes.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(bytes);
}

/** Kod TOTP (RFC 6238) — te same parametry, co w src/lib/crypto/totp.ts. */
export function totpCode(secretBase32: string, atMs = Date.now()): string {
  const counter = Math.floor(atMs / 1000 / 30);
  const buf = Buffer.alloc(8);
  buf.writeBigUInt64BE(BigInt(counter));
  const digest = createHmac("sha1", base32Decode(secretBase32)).update(buf).digest();
  const offset = digest[digest.length - 1] & 0x0f;
  const code =
    ((digest[offset] & 0x7f) << 24) |
    ((digest[offset + 1] & 0xff) << 16) |
    ((digest[offset + 2] & 0xff) << 8) |
    (digest[offset + 3] & 0xff);
  return String(code % 1_000_000).padStart(6, "0");
}

/** Logowanie przez formularz. Czeka na opuszczenie /login. */
export async function login(page: Page, role: Role): Promise<void> {
  const account = ACCOUNTS[role];
  await page.goto("/login");
  await page.getByLabel("Login").fill(account.username);
  await page.getByLabel("Hasło", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Zaloguj się" }).click();
  // Komunikat zawiera rolę: najczęstsza przyczyna porażki to konto wyłączone
  // lub zablokowane przez wcześniejszy test, a nie zły selector.
  await expect(
    page,
    `logowanie ${account.username} nie wyszło z /login (konto wyłączone, zablokowane albo złe hasło?)`,
  ).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** Logowanie konta z 2FA: hasło, potem kod TOTP. */
export async function loginWithTotp(page: Page, role: Role, secret: string): Promise<void> {
  const account = ACCOUNTS[role];
  await page.goto("/login");
  await page.getByLabel("Login").fill(account.username);
  await page.getByLabel("Hasło", { exact: true }).fill(account.password);
  await page.getByRole("button", { name: "Zaloguj się" }).click();
  await expect(page.getByLabel("Kod")).toBeVisible({ timeout: 15_000 });
  await page.getByLabel("Kod").fill(totpCode(secret));
  await page.getByRole("button", { name: "Potwierdź kod" }).click();
  await expect(page).not.toHaveURL(/\/login/, { timeout: 15_000 });
}

/** Logowanie przez API (bez UI) — dla testów, które badają coś innego. */
export async function apiLogin(request: APIRequestContext, role: Role): Promise<{ token: string; csrf: string }> {
  const account = ACCOUNTS[role];
  const response = await request.post("/api/auth/login", {
    data: { username: account.username, password: account.password },
  });
  expect(response.ok(), `logowanie API ${account.username}`).toBeTruthy();
  const cookies = response.headersArray().filter((header) => header.name.toLowerCase() === "set-cookie");
  const session = cookies.find((cookie) => cookie.value.startsWith("ub_session="));
  const csrf = cookies.find((cookie) => cookie.value.startsWith("ub_csrf="));
  if (!session || !csrf) throw new Error("Brak cookies sesji w odpowiedzi logowania");
  return {
    token: /ub_session=([^;]+)/.exec(session.value)![1],
    csrf: /ub_csrf=([^;]+)/.exec(csrf.value)![1],
  };
}

/** Plik .xlsx w pamięci — do testów importu. */
export async function buildXlsx(
  rows: (string | number | null)[][],
  sheetName = "Pracownicy",
): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet(sheetName);
  for (const row of rows) sheet.addRow(row);
  const buffer = await workbook.xlsx.writeBuffer();
  return Buffer.from(buffer);
}

/** Unikalny login/nazwa, żeby testy nie kolidowały ze sobą w obrębie przebiegu. */
export function unique(prefix: string): string {
  return `${prefix}${Date.now().toString(36)}${Math.floor(Math.random() * 1000)}`;
}

const SEED_USERNAMES = new Set(Object.values(ACCOUNTS).map((account) => account.username));

/**
 * Przywraca stan kont do seeda: wyłącza konta utworzone przez testy i włącza
 * konta seedowe. Kont nie da się usunąć (audyt i historia zmian wskazują na nie
 * przez FK), więc „sprzątanie" to dezaktywacja — dokładnie ta sama operacja,
 * którą wykonuje administrator archiwizując konto.
 *
 * Funkcja działa przez API na sesji admina (każdy test administracji loguje się
 * jako admin w `beforeEach`). Błędy są ignorowane: sprzątanie nie może zamienić
 * prawdziwej porażki testu w lawinę.
 */
export async function restoreAccounts(page: Page): Promise<void> {
  try {
    const response = await page.request.get("/api/admin/users");
    if (!response.ok()) return;
    const { users } = (await response.json()) as {
      users: { id: number; username: string; role: string; is_active: number }[];
    };
    const cookies = await page.context().cookies();
    const headers = {
      "X-CSRF-Token": cookies.find((cookie) => cookie.name === "ub_csrf")?.value ?? "",
      Cookie: cookies.map((cookie) => `${cookie.name}=${cookie.value}`).join("; "),
    };

    // Najpierw zwalniamy miejsca zajęte przez konta testowe, potem włączamy
    // seedowe — inaczej moglibyśmy chwilowo przekroczyć limit pięciu aktywnych.
    for (const user of users.filter((entry) => !SEED_USERNAMES.has(entry.username) && entry.is_active === 1)) {
      await page.request.patch(`/api/admin/users/${user.id}`, { headers, data: { isActive: false } });
    }
    for (const user of users.filter((entry) => SEED_USERNAMES.has(entry.username) && entry.is_active === 0)) {
      await page.request.patch(`/api/admin/users/${user.id}`, { headers, data: { isActive: true } });
    }
  } catch {
    // Sprzątanie jest best-effort — patrz komentarz wyżej.
  }
}

/**
 * Nowy kontekst przeglądarki z własnym adresem IP dla rate limitu.
 *
 * `browser.newContext()` nie dziedziczy nagłówków kontekstu testowego, więc każdy
 * dodatkowy kontekst trafiałby do wspólnego koszyka `127.0.0.1` i po kilku
 * logowaniach dostawał „Zbyt wiele prób" — mimo że testy mają osobne IP.
 * `slot` przesuwa ostatni oktet, żeby każdy kontekst w teście miał własny budżet.
 */
export async function newClientContext(
  browser: import("@playwright/test").Browser,
  clientIp: string,
  slot: number,
): Promise<import("@playwright/test").BrowserContext> {
  const octets = clientIp.split(".");
  octets[3] = String(((Number(octets[3]) + slot) % 254) + 1);
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  await context.setExtraHTTPHeaders({ "x-e2e-client-ip": octets.join(".") });
  return context;
}

/** Adres dla kontekstów tworzonych poza fixture (np. w `beforeAll`). */
export const GLOBAL_CLIENT_IP = "10.255.255.1";

/** Czy konto o danym loginie jest aktywne (dla asercji po sprzątaniu). */
export async function isAccountActive(page: Page, username: string): Promise<boolean> {
  const response = await page.request.get("/api/admin/users");
  const { users } = (await response.json()) as { users: { username: string; is_active: number }[] };
  return users.find((user) => user.username === username)?.is_active === 1;
}
