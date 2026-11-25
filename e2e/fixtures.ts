/**
 * Wspólne fixture Playwrighta.
 *
 * Każdy test dostaje unikalny adres IP (nagłówek `x-e2e-client-ip`), bo rate limit
 * logowań działa per IP i wszystkie testy wychodzą z jednego hosta. Bez tego
 * drugi plik testowy zaczynałby od wyczerpanego budżetu 10 logowań / 5 min.
 *
 * Adres jest deterministyczny (hash identyfikatora testu), więc powtórka testu
 * trafia w ten sam licznik — zachowanie jest powtarzalne.
 */
/* eslint-disable react-hooks/rules-of-hooks -- `use` to fixture Playwrighta, nie hook Reacta. */
import { test as base, expect } from "@playwright/test";
import { createHash } from "node:crypto";

export const test = base.extend<{ clientIp: string }>({
  clientIp: [
    async ({}, use, testInfo) => {
      const digest = createHash("sha256").update(testInfo.testId).digest();
      // 10.x.y.z — zakres prywatny, unikalny per test.
      const ip = `10.${digest[0]}.${digest[1]}.${(digest[2] % 254) + 1}`;
      await use(ip);
    },
    { auto: true },
  ],
  // Nadpisujemy kontekst: nagłówek musi być ustawiony przed pierwszym żądaniem.
  context: async ({ context, clientIp }, use) => {
    await context.setExtraHTTPHeaders({ "x-e2e-client-ip": clientIp });
    await use(context);
  },
});

export { expect };
