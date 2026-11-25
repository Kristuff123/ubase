# Obraz produkcyjny userbase.
#
# Trzy etapy: deps (zależności), builder (next build), runtime (serwer standalone
# + skrypty operacyjne). Kontener działa jako użytkownik nieuprzywilejowany.
#
# Moduły natywne: better-sqlite3 v13 i @node-rs/argon2 dostarczają gotowe prebuildy
# dla linux-x64/arm64 (glibc i musl), więc NIE kompilujemy ich w obrazie —
# nie potrzebujemy python3/make/g++. Gdyby prebuild był niedostępny dla architektury,
# build zgłosi błąd przy `npm ci` i wtedy trzeba dodać toolchain do etapu deps.

ARG NODE_VERSION=24-bookworm-slim

# ---------- deps ----------
FROM node:${NODE_VERSION} AS deps
WORKDIR /app
COPY package.json package-lock.json ./
# `npm ci` respektuje lockfile — build jest powtarzalny.
RUN npm ci --include=dev

# ---------- builder ----------
FROM node:${NODE_VERSION} AS builder
WORKDIR /app
ENV NEXT_TELEMETRY_DISABLED=1

COPY --from=deps /app/node_modules ./node_modules
COPY . .

# Build nie potrzebuje prawdziwego klucza — wszystkie strony i API są dynamiczne,
# więc żaden sekret nie jest wczytywany w czasie kompilacji. Wartość zastępcza
# zabezpiecza ewentualny statyczny render strony dotykającej bazy.
RUN USERBASE_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))") npm run build

# ---------- runtime ----------
FROM node:${NODE_VERSION} AS runtime
WORKDIR /app
ENV NODE_ENV=production \
    NEXT_TELEMETRY_DISABLED=1 \
    PORT=3000 \
    HOSTNAME=0.0.0.0 \
    USERBASE_DB_PATH=/data/userbase.db \
    USERBASE_BACKUP_DIR=/backups

# `tini` jako PID 1 — poprawne przekazywanie sygnałów i sprzątanie procesów.
RUN apt-get update \
  && apt-get install -y --no-install-recommends tini ca-certificates \
  && rm -rf /var/lib/apt/lists/* \
  && groupadd --system --gid 10001 userbase \
  && useradd --system --uid 10001 --gid userbase --home /app userbase

# Serwer standalone + statyczne zasoby.
COPY --from=builder --chown=userbase:userbase /app/.next/standalone ./
COPY --from=builder --chown=userbase:userbase /app/.next/static ./.next/static
COPY --from=builder --chown=userbase:userbase /app/public ./public

# Migracje muszą być dostępne w runtime — standalone ich nie kopiuje.
COPY --from=builder --chown=userbase:userbase /app/src/db/migrations ./db/migrations

# Skrypty operacyjne (db:init, backup, restore, rotacja kluczy, CLI) działają
# na tych samych plikach co aplikacja — używają CJS, więc nie wymagają buildu.
# `outputFileTracingIncludes` w next.config.ts gwarantuje, że moduły natywne
# są już w standalone/node_modules.
COPY --chown=userbase:userbase scripts ./scripts
COPY --chown=userbase:userbase package.json ./

# Katalogi danych — montowane jako wolumeny, ale tworzone z właściwym właścicielem.
RUN mkdir -p /data /backups && chown -R userbase:userbase /data /backups

USER userbase
EXPOSE 3000

# Healthcheck korzysta z endpointu bez autoryzacji; sprawdza też, czy klucz danych jest dostępny.
HEALTHCHECK --interval=30s --timeout=5s --start-period=20s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:'+(process.env.PORT||3000)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

ENTRYPOINT ["/usr/bin/tini", "--"]
CMD ["node", "server.js"]
