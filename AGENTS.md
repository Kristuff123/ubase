# AGENTS.md — userbase

> Dokument przekazania projektu. Jeśli wracasz do tego repo po przerwie (lub przejmuje
> je inny agent), **przeczytaj tę stronę w całości** — zawiera stan faktyczny, nie plany.

## 1. Co to jest

Wewnętrzna baza pracowników i ich dostępów dla działu IT piekarni. Zastępuje pięć
niezależnych systemów (chipy, Axel, bClient, dostęp zdalny, monitoring) jednym
miejscem z szyfrowaniem, pełnym audytem i archiwum.

**Użytkownicy:** wyłącznie dział IT — twardy limit **5 aktywnych kont**.
**Role:** `admin` (wszystko), `operator` (edycja danych, bez administracji kontami),
`audytor` (tylko odczyt + audyt i eksport).

Dokument projektowy z uzasadnieniami:
[`docs/superpowers/specs/2026-11-25-userbase-design.md`](docs/superpowers/specs/2026-11-25-userbase-design.md).
Sekcja 19 tego dokumentu opisuje stan implementacji i znalezione defekty.

## 2. Stack

| Element | Wersja | Uwagi |
| --- | --- | --- |
| Next.js | 16.4.6 | App Router, Turbopack, `output: "standalone"` |
| React | 19.3.0 | `"use client"` tylko tam, gdzie potrzebna interaktywność |
| TypeScript | 5.x | `strict: true` |
| Tailwind CSS | 4.3.3 | przez `@tailwindcss/turbopack`, style w `src/styles/design.css` |
| SQLite | better-sqlite3 13.2.0 | **synchroniczny** — patrz pułapki w §10 |
| Argon2id | `@node-rs/argon2` 2.x | prebuild, bez kompilacji w obrazie |
| Testy | Vitest 5 (jednostkowe/integracyjne) + Playwright 1.65 (E2E) | |
| Runtime | Node 24 (bookworm-slim), obraz trzyetapowy | użytkownik `userbase` (uid 10001) |

Projekt jest ESM (`"type": "module"`). Skrypty operacyjne w `scripts/` są **CJS**
(`.cjs`), bo działają bez etapu budowania.

## 3. Szybki start (lokalnie)

```bash
npm ci

# Klucz główny (KEK) — 32 bajty base64. Bez niego aplikacja nie odszyfruje sekretów.
export USERBASE_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export USERBASE_DB_PATH=./data/userbase.db

node scripts/db-init.cjs        # migracje + konto admina (hasło w logu, wymuszona zmiana)
npm run dev                     # http://localhost:3000
```

W trybie deweloperskim cookie nie ma flagi `Secure` (HTTP). W produkcji `COOKIE_SECURE=1`
jest ustawiane przez `docker-compose.yml`.

## 4. Polecenia

| Polecenie | Co robi |
| --- | --- |
| `npm run dev` | Serwer deweloperski |
| `npm run build` | Build produkcyjny (standalone) |
| `npm start` | Uruchomienie zbudowanej aplikacji |
| `npm test` | Testy Vitest (211 testów) |
| `npm run e2e` | Playwright (80 testów: 70 funkcjonalnych + 10 wizualnych) — **wymaga `npm run build`** |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint` | ESLint (0 błędów; 7 zamierzonych ostrzeżeń) |
| `npm run db:init` | Migracje + bootstrap admina |
| `npm run backup` | Kopia zapasowa (`VACUUM INTO` + AES-256-GCM) |
| `npm run restore <plik>` | Odtworzenie kopii |
| `npm run key:rotate-kek` | Rotacja klucza głównego (przepakowuje DEK-i) |
| `npm run cli -- <polecenie>` | Operacje administracyjne: `status`, `audit:verify`, `user:list`, `user:add`, `user:reset`, `worker:purge <id> --yes`, `units:import <plik.csv>`, `rekey:dek` |

**Kolejność weryfikacji przed uznaniem pracy za skończoną:**
`npm run typecheck` → `npm test` → `npm run build` → `npm run e2e` → `npm run lint`.

## 5. Architektura

```
src/
  app/                     # App Router: strony + route handlery API
    api/…                  # wszystkie endpointy (force-dynamic, brak cache)
    (strony: /, /login, /pracownicy/[id], /import, /audyt, /administracja, /konto)
  components/              # komponenty klienckie ("use client")
  db/
    index.ts               # połączenie + migracje (PRAGMA user_version)
    keys.ts                # zarządzanie wersjami kluczy (crypto_keys)
    migrations/*.sql       # 001_init, 002_seed_categories, 003_session_reauth
  lib/
    api.ts                 # mapowanie błędów → odpowiedzi HTTP
    auth/                  # context (requireUser/requireEdit/requireAdmin), sesje, TOTP, rate limit
    audit/                 # chain (hash), log (zapis/odczyt), labels (etykiety PL)
    crypto/                # envelope (AES-256-GCM), password (Argon2id), password-gen, totp
    domain/                # workers, org, import, types — logika biznesowa
    import-handler.ts      # wspólny upload .xlsx dla preview i commit
scripts/                   # db-init, backup, restore, rotate-kek, deploy-init, cli (CJS)
e2e/                       # Playwright: seed.mjs, server.mjs (TLS), fixtures, helpers, *.spec.ts
tests/                     # Vitest: unit + integracyjne (API na prawdziwej bazie w pamięci/pliku)
deploy/                    # Caddyfile, .env.example, secrets/ (klucze poza repo)
```

### Przepływ żądania

1. `src/proxy.ts` generuje dla każdej strony nonce CSP, przekazuje je w nagłówku
   `Content-Security-Policy` i request header `x-nonce`; Next.js automatycznie dodaje
   nonce do skryptów renderowanych po stronie serwera.
2. `next.config.ts` dokłada pozostałe nagłówki bezpieczeństwa (HSTS,
   `X-Frame-Options` i pozostałe).
3. Route handler woła `requireUser({ write: true })` z `src/lib/auth/context.ts`.
4. `requireUser` czyta cookie `ub_session`, haszuje token SHA-256 i szuka sesji;
   odrzuca sesje wygasłe (idle 30 min / absolute 12 h) i `pending_2fa`.
4. Dla żądań zapisu `api.ts` weryfikuje CSRF (nagłówek `X-CSRF-Token` = cookie `ub_csrf`).
5. Logika domenowa w `src/lib/domain/*` działa na `better-sqlite3` **synchronicznie**.
6. Każda zmiana dopisuje `appendAudit(...)` — najlepiej w tej samej transakcji.

## 6. Model bezpieczeństwa

- **Szyfrowanie kopertowe** — każdy sekret szyfrowany AES-256-GCM osobnym kluczem
  danych (DEK). DEK-i są opakowane kluczem głównym (KEK) w tabeli `crypto_keys`.
  KEK pochodzi z `USERBASE_KEK` (base64, 32 B) albo `USERBASE_KEK_FILE` (Docker secrets).
  Format payloadu: `v1.<iv_b64>.<tag_b64>.<ct_b64>`.
- **AAD per pole** — `worker_access:<id>:<field>` / `app_user:<id>:totp`, więc
  podmiana zaszyfrowanej wartości między rekordami jest wykrywalna.
- **Hasła aplikacji** — Argon2id (`m=65536, t=3, p=1`).
- **Sesje** — token losowy, w bazie tylko SHA-256. HttpOnly, `SameSite=Strict`,
  `Secure` w produkcji. Osobny token CSRF (double-submit).
- **Step-up reauth** — podejrzenie sekretu wymaga ponownego hasła w oknie 5 min
  (`sessions.reauth_at`).
- **Blokada konta** — 5 nieudanych prób → 15 min (licznik w bazie, przeżywa restart),
  plus rate limit per IP (10/5 min) i per konto (5/15 min) w pamięci procesu.
- **Audyt append-only** — `SHA-256(prev_hash || canonicalJson(payload))`; triggery
  blokują `UPDATE`/`DELETE` na `audit_events`. Weryfikacja: `GET /api/audit/verify`.
- **Historia zmian** nie przechowuje wartości sekretów (redakcja) — inaczej byłaby
  drugą kopią haseł.

**Nie loguj nigdy:** wartości sekretów, haseł, sekretów TOTP, kodów odzyskiwania, KEK.

## 7. Baza danych

Migracje: `src/db/migrations/NNN_nazwa.sql`, stosowane po numerze, w transakcji,
przy pierwszym połączeniu. Wersja schematu = `PRAGMA user_version`.

| Wersja | Zakres |
| --- | --- |
| 1 | Tabele: `app_users`, `sessions`, `workers`, `org_units`, `categories`, `worker_accesses`, `access_fields`, `audit_events`, `record_history`, `crypto_keys`, `app_user_secrets` |
| 2 | 7 kategorii systemowych z definicjami pól (JSON w `field_schema`) |
| 3 | `sessions.reauth_at` (okno step-up) |

**Dodając migrację:** nowy plik z kolejnym numerem, nigdy nie edytuj istniejących
(na produkcji już je zastosowano). Migracja musi być idempotentna w granicach
transakcji — jeśli padnie, `user_version` nie zostanie podniesione.

## 8. API (route handlery)

| Ścieżka | Metody | Rola |
| --- | --- | --- |
| `/api/auth/login`, `/api/auth/2fa`, `/api/auth/logout`, `/api/auth/reauth`, `/api/auth/me` | POST/GET | publiczne / sesja |
| `/api/workers`, `/api/workers/[id]`, `/api/workers/[id]/[action]` | GET/POST/PATCH | operator+ |
| `/api/workers/[id]/accesses`, `/api/workers/[id]/export`, `/api/workers/[id]/history` | GET/POST/DELETE | operator+ / audytor (export) |
| `/api/accesses/[id]/reveal`, `/api/accesses/[id]/copied` | POST | operator+ (reveal z reauth) |
| `/api/import/preview`, `/api/import/commit` | POST (multipart) | operator+ |
| `/api/audit`, `/api/audit/verify`, `/api/audit/export` | GET | audytor+ |
| `/api/admin/users`, `/api/admin/users/[id]` | GET/POST/PATCH | admin |
| `/api/admin/org-units`, `/api/admin/categories/[id]` | GET/POST/PATCH | admin |
| `/api/account/password`, `/api/account/2fa` | POST/DELETE | zalogowany |
| `/api/catalog`, `/api/generator`, `/api/health` | GET | sesja / publiczne |

Wszystkie handlery zwracają błędy przez `handleApiError` z `{ error, code }`.

## 9. Konwencje kodu

- **Język:** identyfikatory po angielsku, komunikaty dla użytkownika i komentarze
  po polsku. Komentarz wyjaśnia **dlaczego**, nie „co robi linijka".
- **Typy domenowe** w `src/lib/domain/types.ts`; brak `any` w nowym kodzie.
- **Komponenty** — domyślnie serwerowe; `"use client"` tylko przy stanie/eventach.
- **Stylowanie** — klasy `ub-*` (`ub-card`, `ub-btn`, `ub-input`, `ub-chip`) i zmienne
  CSS. `--ub-accent-text` oznacza tekst akcentowy, `--ub-accent` tło przycisku;
  `--ub-btn-primary-text` dobiera jasny tekst do ciemnego bursztynu w motywie jasnym.
  `--ub-text-dim` ma kontrast ≥ 4.5:1 na pięciu podstawowych tłach obu motywów.
  Nie dodawaj nowych kolorów poza paletą w `design.css`.
- **Brak `await` w transakcjach** `better-sqlite3` — patrz §10.
- Każda nowa akcja audytu musi dostać etykietę w `src/lib/audit/labels.ts`
  (pilnuje tego `tests/audit/labels.test.ts`).

## 10. Pułapki (na tym projekcie już się zdarzyły)

1. **`better-sqlite3` jest synchroniczny.** `db.transaction(() => { ... })` nie może
   zawierać `await` — callback musi być w całości synchroniczny. Hashowanie hasła
   (Argon2) jest asynchroniczne, więc robi się je **przed** transakcją.
2. **Migracje czytają katalog dynamicznie** — Next tracer ostrzega o „tracing whole
   project". Ostrzeżenie jest znane i nieszkodliwe; nie „naprawiaj" go, zmieniając
   ścieżki na statyczne (migracje muszą być odkrywane po nazwie pliku).
3. **Cookie `Secure` + HTTP = brak ciasteczka.** Chromium odrzuca `Secure` cookies po
   HTTP nawet na `127.0.0.1`. Dlatego E2E terminuje TLS (`e2e/server.mjs`).
4. **`playwright` `selectOption` nie przyjmuje regeksów** — tylko dokładne wartości
   lub `{ label: "..." }` z literałem.
5. **`getByRole(...name)` dopasowuje podciągi bez `exact: true`** — główne źródło
   błędów strict mode. Zawężaj do konkretnego kontenera (`.ub-card`, `tbody tr`).
6. **`browser.newContext()` nie dziedziczy nagłówków** z konfiguracji testu — nowy
   kontekst trafia do wspólnego koszyka rate limitu. Używaj `newClientContext()`.
7. **Testy E2E dzielą jedną bazę i działają na jednym workerze.** Test, który zmienia
   stan (wyłącza konto, zmienia hasło, włącza 2FA), **musi** go przywrócić — inaczej
   kaskadowo psuje kolejne testy. Wzorce: `restoreAccounts()`, dedykowane konta
   (`blokada`), własne konteksty z osobnym IP.
8. **Nagłówki HTTP to ByteString (0–255).** Polskich znaków nie da się wstawić do
   nagłówka — `contentDisposition()` w `src/lib/http.ts` używa ASCII `filename`
   + RFC 5987 `filename*`.
9. **React nie renderuje obiektów.** `errors: {rowNumber, message}[]` renderowane jako
   `{message}` wywala całą stronę na 500 (zdarzyło się przy imporcie — patrz §12).

10. **Szerokość strony nie wykrywa przewijania wewnątrz karty.** Długie nazwisko
    rozszerza tabelę z `table-auto`, nawet jeśli rodzic ma `overflow-x-auto` i strona
    mieści się w ekranie. Lista pracowników używa `table-fixed` poniżej `sm`, osobnej
    szerokości kolumny dostępów i skracania nazwy; regresja mierzy kartę, nie tylko root.

11. **`process.exit()` nie uruchamia bloków `finally`.** Sprawdzone eksperymentem.
    Skrypt, który kończy proces przez `lib.fail()` wewnątrz `try`, **nie posprząta**
    katalogu tymczasowego — a w `restore.cjs` ten katalog zawiera odszyfrowaną bazę
    ze wszystkimi sekretami. Dlatego oczekiwane błędy rzucamy (`lib.abort()` →
    `ScriptError`) i obsługujemy je w jednym `catch` na końcu `main`. `lib.fail()`
    zostaje tylko dla błędów, po których nie ma czego sprzątać.

12. **Znacznik czasu w nazwach plików kopii musi mieć milisekundy.** Wersja z sekundami
    (`slice(0, 19)`) powodowała, że druga kopia w tej samej sekundzie nadpisywała
    pierwszą — cicha utrata kopii. Dodatkowo `VACUUM INTO` odmawia zapisu do
    istniejącego pliku, więc kolizja dawała albo błąd, albo (przy szyfrowaniu) ciche
    nadpisanie. `lib.uniqueBase()` dokłada `-2`, `-3`… i sprawdza oba warianty końcówki
    (`.db` i `.db.enc`) naraz.

13. **`VACUUM INTO` daje plik kompletny — bez `-wal`.** Sprawdzone: snapshot nie ma
    sidecara, a wiersze, które przed kopią żyły w WAL-u aplikacji, są w środku.
    Nie trzeba (i nie wolno) dociągać `-wal`/`-shm` do kopii; kopiowanie samego `.db`
    **po** `VACUUM INTO` jest poprawne.

## 11. Testy

### Vitest (`tests/`)

- `tests/setup.ts` przygotowuje tymczasową bazę i klucz KEK dla każdego pliku.
- Integracyjne testy API wołają handlery bezpośrednio (bez serwera HTTP).
- Nowa funkcja = nowy test; poprawka błędu = test regresyjny.
- `tests/ops/backup-restore.test.ts` — testy skryptów operacyjnych. Uruchamiają
  `scripts/*.cjs` jako **osobne procesy** (`spawnSync`), bo tak działają na produkcji:
  własny `process.env`, własne `process.exit()`, własne pliki tymczasowe. Importowanie
  ich do procesu Vitest fałszywałoby obraz. Każdy test ma własny katalog tymczasowy
  i losowane klucze. Zakres: round-trip z odszyfrowaniem sekretu, kopie w tej samej
  milisekundzie, retencja, zły klucz backupu, zły KEK, uszkodzony plik, brak wycieku
  jawnych danych do `.enc` i do katalogu tymczasowego.

### Playwright (`e2e/`)

- `e2e/seed.mjs` — deterministyczny seed: 5 kont, jednostki (3 regiony, 6 zakładów,
  2 sklepy, biuro), 1 pracownik z dostępem i sekretem `tajne-haslo-axel-123`.
- `e2e/server.mjs` — kopiuje `.next/static` do standalone i stawia TLS (porty 3443/3444).
- `e2e/fixtures.ts` — unikalny `x-e2e-client-ip` per test (izolacja rate limitu).
- `e2e/helpers.ts` — `login`, `loginWithTotp`, `apiLogin`, `buildXlsx`, `unique`,
  `restoreAccounts`, `newClientContext`.
- `e2e/99-visual.spec.ts` — 10 widoków, syntetyczne dane demonstracyjne dodawane przez API;
  zrzuty w `e2e/.visual/` (ignorowane). Uruchom osobno przez
  `npx playwright test e2e/99-visual.spec.ts`, aby nie pokazywać danych z testów funkcjonalnych.
  Testy mierzą kontrast awatara (≥ 4.5:1), szerokość strony i osobno mobilnej karty tabeli
  z długim nazwiskiem. Zielony test nie zastępuje obejrzenia zrzutów.
- `e2e/01-smoke.spec.ts` weryfikuje również nonce CSP: nonce jest unikalny dla
  odpowiedzi i zgodny z nonce skryptów renderowanych przez Next.
- Uruchamiaj `npm run build` przed `npm run e2e` — testy idą przeciw buildowi.
- GitHub Actions (`.github/workflows/ci.yml`) uruchamia na push i pull request
  kolejno: `npm run typecheck`, `npm test`, `npm run build`, Playwright Chromium
  z zależnościami systemowymi, `npm run e2e` i `npm run lint`. Workflow ma tylko
  uprawnienie `contents: read`; testowe sekrety są deterministyczne i lokalne dla E2E.

## 12. Znalezione defekty (nie powtarzaj tych błędów)

| Defekt | Objaw | Przyczyna |
| --- | --- | --- |
| Blokada konta z hasłem startowym | 403 `Nieprawidłowy token CSRF` na zawsze | formularz zmiany hasła nie wysyłał `X-CSRF-Token` |
| Fałszywy licznik importu | przycisk pokazywał inną liczbę niż baza | licznik z `summary.ok` zamiast serwerowego `importable` |
| Biały ekran po imporcie | strona 500 **po** udanym imporcie | `errors` typowane jako `string[]`, serwer zwraca obiekty |
| Surowy slug w audycie | `backup.created` zamiast „Kopia zapasowa" | brak 7 etykiet |
| Brak resetu 2FA | osoba bez telefonu odcięta na stałe | brak endpointu i przycisku |
| Kopie nadpisywały się w tej samej sekundzie | z 3 kopii zostawała 1, bez żadnego błędu | znacznik czasu do sekund, brak unikalizacji nazwy |
| Kopie szyfrowane nigdy nie były weryfikowane | `backup` raportował sukces, ale plik `.enc` nie był sprawdzony | weryfikacja tylko w gałęzi bez szyfrowania — czyli nigdy na produkcji |
| Odszyfrowana baza zostawała po nieudanym restore | jawny plik z sekretami obok kopii | `lib.fail()` → `process.exit()` pomija `finally` |

## 13. Wdrożenie

```bash
cp deploy/.env.example deploy/.env       # ustaw USERBASE_HOST
node scripts/deploy-init.cjs             # generuje deploy/secrets/{kek,backup_key}
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env exec app node scripts/db-init.cjs
```

- `app` — Next standalone, port 3000 tylko na `127.0.0.1` (ruchu nie wystawiamy wprost).
- `backup` — ten sam obraz, kopia co 6 h, retencja `USERBASE_BACKUP_KEEP` (domyślnie 14).
- `caddy` — reverse proxy z automatycznym TLS (Let's Encrypt), porty 80/443.

**Sekrety** leżą w plikach (`deploy/secrets/`), nie w zmiennych środowiskowych —
nie trafiają do `docker inspect` ani historii powłoki. `deploy/secrets/.gitignore`
blokuje ich commitowanie.

**Odtworzenie po awarii:** `npm run restore -- <plik>`. Restore weryfikuje po kolei:
odszyfrowanie kluczem backupowym → `PRAGMA integrity_check` → łańcuch audytu →
odszyfrowanie DEK bieżącym KEK. Jeśli którykolwiek krok padnie, nie nadpisuje bazy.
Kopia zaszyfrowana jest odszyfrowywana do katalogu tymczasowego usuwanego **także przy
błędzie** — odszyfrowana baza zawiera wszystkie sekrety i nie może zostać na dysku.

**Kopie są weryfikowane przy tworzeniu** — także zaszyfrowane (odszyfrowanie do
katalogu tymczasowego i pełna weryfikacja). Log `backup` musi zawierać
`Kopia zaszyfrowana: integralność OK, audyt OK (N wpisów), DEK vX`. Nazwy plików mają
znacznik z milisekundami i sufiks `-2`, `-3` przy kolizji — dwie kopie w tej samej
sekundzie nie nadpisują się (wcześniej tak było: druga kopia cicho zastępowała pierwszą).

**Zweryfikowane w praktyce (2026-11-25):** `db:init` → `backup` → `restore` → `rekey:dek`
na czystej bazie; restore potwierdził integralność SQLite, łańcuch audytu i DEK,
a po rotacji łańcuch pozostał poprawny. `docker compose config` zwraca 0.
Cykl backup → restore jest **zautomatyzowany** w `tests/ops/backup-restore.test.ts`
(15 testów: round-trip z sekretem, kopie w tej samej milisekundzie, retencja,
zły klucz backupu, zły KEK, uszkodzony plik, brak wycieku jawnych danych).
**Nie zweryfikowano:** samego `docker compose build` — brak dostępu do registry
w środowisku agenta.

## 14. Stan bieżący i następne kroki

**v1 jest kompletne:** 211 testów jednostkowych/integracyjnych, 70 funkcjonalnych E2E
+ 10 wizualnych, `tsc --noEmit` bez błędów, `next build` przechodzi, ESLint 0 błędów.

Do zrobienia w przyszłości (nie blokuje wdrożenia):

1. **Rate limit w bazie/Redis** — jeśli kiedykolwiek pojawi się więcej niż jeden kontener.
3. **Import wielu arkuszy i `.csv`** — schemat jest na to gotowy, brakuje UI.
4. **Weryfikacja obrazu Dockera** — w środowisku agenta brak dostępu do registry;
   zweryfikowano artefakt standalone i `docker compose config`.
5. **Harmonogram testu odtworzenia na kopii produkcyjnej** — logika jest już pokryta
   (`tests/ops/backup-restore.test.ts`), ale nikt nie uruchamia restore na prawdziwej
   kopii z `deploy/`. Warto dorzucić okresowy job, który odtwarza ostatnią kopię do
   katalogu tymczasowego i porównuje liczniki.

## 15. Zasady pracy nad tym projektem

- **Najpierw test, potem kod** — dla każdej zmiany produktowej.
- **Nie osłabiaj testów**, żeby uzyskać zielony wynik. Jeśli test jest zły, popraw test
  i wyjaśnij dlaczego w komentarzu.
- **Nie deklaruj sukcesu bez uruchomienia** poleceń z §4.
- **Aktualizuj ten plik**, gdy zmienia się architektura, zależności, procedury,
  schemat bazy albo pojawiają się nowe pułapki.
- **Nie commituj sekretów** i nie wypisuj ich w logach.
