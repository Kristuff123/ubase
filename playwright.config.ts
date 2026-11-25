import { defineConfig, devices } from "@playwright/test";
import path from "node:path";

/**
 * Playwright E2E — testuje build produkcyjny za lokalnym TLS.
 *
 * Aplikacja ustawia cookie `Secure`, a Chromium odrzuca takie cookies po HTTP,
 * więc serwer testowy terminuje TLS (e2e/server.mjs). Dzięki temu ścieżka
 * testowana jest identyczna z produkcyjną: standalone server + HTTPS + HttpOnly.
 *
 * Wymagania wstępne: `npm run build` oraz klucz główny w env (patrz webServer.command).
 * Bootstrap bazy robi `e2e/seed.mjs` przy każdym starcie — stan jest deterministyczny.
 */
export const E2E_PORT = 3443;
const E2E_BACKEND_PORT = 3444;
const BASE_URL = `https://127.0.0.1:${E2E_PORT}`;

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? [["list"], ["html", { open: "never" }]] : [["list"]],
  timeout: 45_000,
  expect: { timeout: 10_000 },
  use: {
    baseURL: BASE_URL,
    ignoreHTTPSErrors: true, // certyfikat testowy jest samopodpisany
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
    locale: "pl-PL",
    timezoneId: "Europe/Warsaw",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: {
    // Seed + serwer w jednym poleceniu: baza zawsze odpowiada wersji kodu.
    command: "node e2e/seed.mjs && node e2e/server.mjs",
    url: `${BASE_URL}/api/health`,
    reuseExistingServer: false,
    // Certyfikat testowy jest samopodpisany — dotyczy też health-checku webServera.
    ignoreHTTPSErrors: true,
    timeout: 120_000,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      // Klucz testowy — deterministyczny, wyłącznie na potrzeby E2E.
      USERBASE_KEK: Buffer.alloc(32, 7).toString("base64"),
      USERBASE_DB_PATH: path.join(process.cwd(), "e2e", ".tmp", "userbase.db"),
      NODE_ENV: "production",
      E2E_PORT: String(E2E_PORT),
      E2E_BACKEND_PORT: String(E2E_BACKEND_PORT),
    },
  },
  outputDir: "./e2e/.artifacts",
});
