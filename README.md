# Userbase

Baza pracowników i dostępów dla działu IT piekarni — jedno miejsce zamiast pięciu
niezależnych systemów. Szyfrowanie per pole (AES-256-GCM), pełny audyt
z łańcuchem hashy, archiwum zamiast kasowania, import z Excela.

**Dla kogo:** wyłącznie dział IT, maksymalnie 5 aktywnych kont.
**Role:** administrator (wszystko), operator (edycja), audytor (odczyt + audyt).

---

## Szybki start

```bash
npm ci

# Klucz główny — bez niego aplikacja nie odszyfruje sekretów.
export USERBASE_KEK=$(node -e "console.log(require('crypto').randomBytes(32).toString('base64'))")
export USERBASE_DB_PATH=./data/userbase.db

npm run db:init     # migracje + konto admina (hasło wypisane w konsoli)
npm run dev         # http://localhost:3000
```

Hasło startowe administratora jest wypisywane **tylko do konsoli** i wymaga zmiany
przy pierwszym logowaniu. Potem włącz 2FA w „Moje konto".

## Wdrożenie produkcyjne (Docker)

```bash
cp deploy/.env.example deploy/.env    # ustaw USERBASE_HOST
node scripts/deploy-init.cjs          # generuje klucze do deploy/secrets/
docker compose --env-file deploy/.env up -d --build
docker compose --env-file deploy/.env exec app node scripts/db-init.cjs
```

Trzy kontenery:

| Kontener | Rola |
| --- | --- |
| `app` | Serwer Next.js (port 3000 tylko na `127.0.0.1`) |
| `backup` | Kopia zapasowa co 6 h, szyfrowana, retencja 14 kopii |
| `caddy` | Reverse proxy z automatycznym TLS (Let's Encrypt) |

**Zabezpiecz `deploy/secrets/kek`.** Utrata tego pliku oznacza trwałą utratę
wszystkich zaszyfrowanych sekretów — kopie zapasowe nie pomogą, bo odtworzenie
wymaga tego samego klucza głównego. `deploy/secrets/backup_key` jest osobnym
sekretem, potrzebnym do odszyfrowania plików kopii.

## Funkcje

### Kartoteka pracowników
Szybkie dodawanie (imię, nazwisko, jednostka), wyszukiwarka odporna na polskie znaki
(„zolkiewska" znajdzie „Żółkiewską"), filtr aktywni/archiwum. Dane osobowe ograniczone
do minimum — **bez PESEL i adresów**; służbowy e-mail i telefon są opcjonalne.

### Dostępy i sekrety
Kategorie: chip (numer + poziomy: piekarnia, cukiernia, biura, pierogarnia, alarm),
Axel, bClient (z nazwą sklepu), dostęp zdalny, monitoring (region/zakład/wszystkie),
poczta, Google, „inne" z własnymi polami.

Każdy sekret jest szyfrowany osobno (AES-256-GCM). Podejrzenie wartości wymaga
ponownego potwierdzenia hasła i jest rejestrowane w audycie; wartość znika z ekranu
po 30 sekundach.

### Generator haseł
Domyślnie 8 znaków, wyłącznie małe litery i cyfry, maksymalnie 3 cyfry —
zgodnie z wymaganiami systemów, do których te hasła trafiają.

### Pełna historia
Log zdarzeń jest tylko do dopisywania, każdy wpis zawiera hash poprzedniego.
Podmiana lub usunięcie wpisu w środku jest wykrywalne przyciskiem
„Sprawdź integralność". Eksport do CSV. Wartości haseł **nie** trafiają do historii.

### Import z Excela
Czterokrokowy kreator: plik → mapowanie kolumn (dopasowywane automatycznie) →
podgląd z rozwiązywaniem nieznanych jednostek → zapis. Import dodaje osoby i nigdy
nie nadpisuje istniejących; duplikaty są oznaczane przed zapisem.

### Administracja
Konta (twardy limit 5), jednostki organizacyjne, kategorie dostępów, wersje kluczy
szyfrowania. Reset hasła i reset 2FA dla osoby, która zgubiła dostęp.

## Bezpieczeństwo

- **Szyfrowanie kopertowe** — każdy sekret ma własny klucz danych (DEK), opakowany
  kluczem głównym (KEK) trzymanym poza bazą.
- **Hasła aplikacji** — Argon2id.
- **Sesje** — HttpOnly, `SameSite=Strict`, `Secure`; w bazie tylko hash tokenu.
  Wygaszenie po 30 min bezczynności i po 12 h bezwzględnie.
- **2FA** — TOTP (RFC 6238) + 10 jednorazowych kodów odzyskiwania.
- **Ochrona przed zgadywaniem** — blokada konta po 5 próbach (15 min) oraz limity
  per IP i per konto.
- **CSRF** — podwójne ciasteczko + nagłówek przy każdym żądaniu zapisu.
- **Nagłówki** — CSP, HSTS, `X-Frame-Options: DENY`, `nosniff`, `no-referrer`.

## Testy

```bash
npm test          # 211 testów: API, sesje, role, szyfrowanie, audyt, import, kopie zapasowe
npm run build     # wymagane przed E2E
npm run e2e       # 80 testów Playwright: 70 funkcjonalnych + 10 wizualnych, HTTPS
npm run typecheck
npm run lint
```

Testy operacyjne (`tests/ops/backup-restore.test.ts`) uruchamiają `scripts/backup.cjs`
i `scripts/restore.cjs` jako osobne procesy i sprawdzają pełny cykl: kopia → zniszczenie
bazy → odtworzenie → odszyfrowanie sekretu. Pokrywają też ścieżki błędów (zły klucz
backupu, zły klucz główny, uszkodzony plik) i to, że nieudane odtworzenie nie zostawia
jawnej bazy z sekretami.

E2E celowo testuje build produkcyjny po HTTPS — aplikacja ustawia cookie `Secure`,
a przeglądarki odrzucają takie ciasteczka po HTTP. Dzięki temu testowana konfiguracja
jest identyczna z wdrożeniem.

Przegląd wyglądu: `npx playwright test e2e/99-visual.spec.ts`. Dziesięć zrzutów
(logowanie, pracownicy, kartoteka, audyt, import, administracja, konto, motyw jasny
oraz telefon) trafia do `e2e/.visual/`. Dane są syntetyczne i powstają wyłącznie
w bazie testowej. Test mierzy też kontrast awatara i przepełnienie mobilnej tabeli.

## Dokumentacja

- [`AGENTS.md`](AGENTS.md) — przekazanie projektu: architektura, konwencje, pułapki,
  procedury wdrożenia i odtworzenia. **Zacznij tutaj, jeśli przejmujesz to repo.**
- [`docs/superpowers/specs/2026-11-25-userbase-design.md`](docs/superpowers/specs/2026-11-25-userbase-design.md)
  — dokument projektowy z uzasadnieniami decyzji; §19 opisuje stan implementacji.

## Licencja

Wewnętrzne narzędzie firmy — nie jest publikowane.
