#!/usr/bin/env node
/**
 * Serwer testów E2E: terminacja TLS przed samodzielnym buildem Nexta.
 *
 * DLACZEGO HTTPS: aplikacja w produkcji ustawia cookie `Secure`, a Chromium
 * odrzuca takie cookies odebrane po HTTP — nawet na 127.0.0.1. Testowanie po
 * HTTP wymagałoby wyłączenia tej flagi, czyli testowania innej konfiguracji niż
 * produkcyjna. Zamiast tego stawiamy lokalne TLS i przepuszczamy ruch bez zmian.
 *
 * Wymagania: `.next/standalone` musi istnieć (npm run build) oraz `.next/static`
 * musi być skopiowane do `.next/standalone/.next/static` (jak w obrazie Dockera).
 *
 *   node e2e/server.mjs
 *
 * Zmienne: E2E_PORT (443 domyślnie nie wymagane — używamy 3443), E2E_BACKEND_PORT.
 */
import http from "node:http";
import https from "node:https";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const standalone = path.join(root, ".next", "standalone");

export const E2E_PORT = Number(process.env.E2E_PORT || 3443);
export const E2E_BACKEND_PORT = Number(process.env.E2E_BACKEND_PORT || 3444);

const certFile = path.join(root, "e2e", "fixtures", "tls", "cert.pem");
const keyFile = path.join(root, "e2e", "fixtures", "tls", "key.pem");

function ensureStandalone() {
  if (!fs.existsSync(path.join(standalone, "server.js"))) {
    throw new Error(
      "Brak .next/standalone/server.js — najpierw `npm run build` (E2E testuje build produkcyjny, nie dev server).",
    );
  }
  const staticSource = path.join(root, ".next", "static");
  const staticTarget = path.join(standalone, ".next", "static");
  if (!fs.existsSync(staticSource)) {
    throw new Error("Brak .next/static — build nie został ukończony.");
  }
  // Dockerfile robi dokładnie to samo: standalone nie zawiera zasobów statycznych.
  fs.rmSync(staticTarget, { recursive: true, force: true });
  fs.cpSync(staticSource, staticTarget, { recursive: true });
}

function waitForBackend(port, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const request = http.get({ host: "127.0.0.1", port, path: "/api/health" }, (response) => {
        response.resume();
        resolve();
      });
      request.on("error", () => {
        if (Date.now() > deadline) reject(new Error(`Backend nie wstał na porcie ${port}`));
        else setTimeout(attempt, 250);
      });
    };
    attempt();
  });
}

async function main() {
  ensureStandalone();

  const backend = spawn(process.execPath, ["server.js"], {
    cwd: standalone,
    env: {
      ...process.env,
      NODE_ENV: "production",
      PORT: String(E2E_BACKEND_PORT),
      HOSTNAME: "127.0.0.1",
      USERBASE_DB_PATH: process.env.USERBASE_DB_PATH,
      USERBASE_KEK: process.env.USERBASE_KEK,
    },
    stdio: ["ignore", "inherit", "inherit"],
  });

  const stop = () => {
    backend.kill("SIGTERM");
  };
  process.on("SIGTERM", stop);
  process.on("SIGINT", stop);
  backend.on("exit", (code) => process.exit(code ?? 1));

  await waitForBackend(E2E_BACKEND_PORT);

  // Proxy: przekazuje wszystko 1:1, dokłada X-Forwarded-* tak jak Caddy w produkcji.
  // Nagłówek `x-e2e-client-ip` pozwala testom udawać różne adresy — dzięki temu
  // rate limit per IP (10 logowań / 5 min) nie wyczerpuje się między plikami testowymi.
  const proxy = https.createServer(
    { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) },
    (request, response) => {
      const claimedIp = request.headers["x-e2e-client-ip"];
      const clientIp = typeof claimedIp === "string" && claimedIp.trim() ? claimedIp.trim() : (request.socket.remoteAddress ?? "127.0.0.1");
      const upstream = http.request(
        {
          host: "127.0.0.1",
          port: E2E_BACKEND_PORT,
          method: request.method,
          path: request.url,
          headers: {
            ...request.headers,
            // Limit liczy się po ostatnim wpisie X-Forwarded-For (zaufane proxy).
            "x-forwarded-for": clientIp,
            "x-forwarded-proto": "https",
            "x-real-ip": clientIp,
          },
        },
        (upstreamResponse) => {
          response.writeHead(upstreamResponse.statusCode ?? 502, upstreamResponse.headers);
          upstreamResponse.pipe(response);
        },
      );
      upstream.on("error", () => {
        if (!response.headersSent) response.writeHead(502, { "content-type": "text/plain" });
        response.end("Bad gateway");
      });
      request.pipe(upstream);
    },
  );

  proxy.listen(E2E_PORT, "127.0.0.1", () => {
    console.log(`[e2e] https://127.0.0.1:${E2E_PORT} → http://127.0.0.1:${E2E_BACKEND_PORT}`);
  });

  process.on("exit", () => proxy.close());
}

main().catch((error) => {
  console.error(`[e2e] ${error.message}`);
  process.exit(1);
});
