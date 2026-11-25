# Userbase — baza pracowników i dostępów (dokument projektowy)

Data: 2026-11-25
Status: do zatwierdzenia przez właściciela projektu
Autor: zCode (na podstawie rozmowy z działem IT)

## 1. Po co to powstaje

Dziś dane o pracownikach i ich dostępach są rozproszone po pięciu systemach, które ze sobą nie
rozmawiają: chipy w trzech różnych miejscach, Axel osobno, bClient osobno, reszta w Excelach
i szufladach. Odpowiedź na pytanie „co ten człowiek ma i gdzie" wymaga przeklikania pięciu
systemów i telefonu do osoby, która „pamięta".

Cel: **jedno źródło prawdy o człowieku i jego dostępach** — kartoteka pracownika z sekcjami
dostępów, historią zmian i logiem audytowym, które można pokazać audytorowi.

Dodatkowo: nowe przepisy wymagają udokumentowanego, kompletnego śladu tego, kto miał dostęp
do czego i kto te uprawnienia nadawał/odbierał.

## 1a. Jednostki organizacyjne — ustalenia z danych (2026-11-25)

Sprawdzone źródła:

- `/home/da_kos/CODE/doku/wykaz.xlsx` (arkusz „PC zaplecze sklepy", 124 wiersze): kolumny
  `nr sklepu` (75 wypełnionych, 75 unikalnych) i `lokalizacja` (124 wypełnione, 117 unikalnych
  nazw). 49 wierszy nie ma numeru sklepu; część „lokalizacji" to daty (`10.12.24`), nie nazwy.
- `bakery-chain/data.db`: 87 sklepów; regiony = Region Mazowiecki (2 sklepy), Region Pomorski
  (62), Region Zachodniopomorski (23); działy: Piekarnia, Cukiernia, Bistro, Torty. Nazwy
  sklepów to głównie placeholdery (`Sklep 001 — Warszawa`) — tylko 15/87 pokrywa się
  z `wykaz.xlsx`.

Wniosek: **żadne z istniejących źródeł nie jest gotową listą sklepów z prawdziwymi nazwami
i regionami.** Import v1 przyjmuje więc dwa pliki: listę sklepów (nazwa + numer) i mapowanie
sklep → region. Zakłady wpisuje się raz z listy podanej przez użytkownika:

PIEKARNIA, BISTRO, CUKIERNIA, DESERÓWKA, ADMINISTRACJA, PIEROGARNIA.

Model: `org_units` z typem (`region`, `zaklad`, `sklep`, `biuro`), `parent_id` (sklep → region)
i unikalną nazwą w obrębie typu. Regiony na start: Mazowiecki, Pomorski, Zachodniopomorski.
Przypisanie sklepów do regionów wg pliku użytkownika.

Brak numeru sklepu w 49 wierszach wykazu oznacza, że numer sklepu jest **opcjonalny**
w kartotece i w imporcie — inaczej import wywaliłby blisko 40% wierszy.

Poziomy dostępu chipa (piekarnia, cukiernia, biura, pierogarnia, alarm) są **stałą listą
w schemacie pola**, niezależną od listy zakładów — „biura" i „alarm" nie są zakładami.

## 2. Kto tego używa

Wyłącznie dział IT. Maksymalnie 5 kont, każdy z własnym loginem (bez kont współdzielonych —
inaczej audyt nie ma sensu). Trzy role:

| Rola | Może |
|------|------|
| `admin` | wszystko: pracownicy, dostępy, podejrzenie sekretów, konta aplikacji, ustawienia, rotacja kluczy, import |
| `operator` | dodawanie/edycja/archiwizacja pracowników i dostępów, podejrzenie sekretu (po ponownym potwierdzeniu hasłem), import; **nie** zarządza kontami ani kluczami |
| `audytor` | przegląda kartoteki (metadane), historię i log audytowy, eksportuje raporty; **nie widzi sekretów w cleartext, nie edytuje niczego** |

Jedno konto startowe `admin` tworzone przy pierwszym uruchomieniu (hasło losowane i wypisane
jednorazowo do logu kontenera, wymuszona zmiana przy pierwszym logowaniu).

## 3. Zakres danych osobowych

Tylko to, co potrzebne do zarządzania dostępami:

- imię, nazwisko (wymagane),
- stanowisko (opcjonalne),
- sklep / zakład / biuro — jednostka organizacyjna (wymagane),
- służbowy e-mail i telefon — **opcjonalne, tylko dla administracji**,
- notatki.

Świadomie **nie** przechowujemy: PESEL, adresów, danych rodzinnych, numerów dokumentów,
danych medycznych. To nie jest system kadrowy.

## 4. Model dostępów

Dostęp dodawany jest z rozwijanej listy kategorii. Kategoria definiuje zestaw pól; kategorie
są danymi w bazie (nie kodem), więc „inne" i przyszłe systemy dodaje się bez przebudowy.

Kategorie startowe:

| Kategoria | Pola |
|-----------|------|
| **chip** | numer chipa (tekst), poziom dostępu — wielokrotny wybór: piekarnia, cukiernia, biura, pierogarnia, alarm; opcjonalnie data wydania |
| **axel** | login, hasło |
| **bClient** | login, hasło, sklep (jednostka organizacyjna) |
| **dostęp zdalny** | metoda (VPN / RDP / TeamViewer / inne), login, hasło, notatka |
| **monitoring** | zakres: region / zakład / wszystkie; wskazanie konkretnego regionu lub zakładu; login, hasło (opcjonalne) |
| **poczta** | typ konta: firmowe / współdzielone / pracownika; adres, hasło, kody odzyskiwania 2FA (opcjonalne) |
| **Google** | typ konta: firmowe / współdzielone / pracownika; adres, hasło, kody odzyskiwania 2FA (opcjonalne) |
| **inne** | nazwa dostępu + dowolne pary pole/wartość; pole może być oznaczone jako sekret |

Zasady:

- Jeden pracownik może mieć wiele dostępów w tej samej kategorii (np. dwa chipy, trzy sklepy
  w bClient).
- Każdy dostęp ma status `aktywny` / `wycofany` (wycofanie z datą i autorem — nie kasujemy).
- Każde pole ma flagę „sekret" albo „jawne". Jawne: loginy, numery chipów, sklepy, poziomy,
  adresy. Sekretne: hasła, kody odzyskiwania 2FA.
- Przy sekretach pole „czyj to zasób": firma / pracownik — potrzebne przy pytaniach audytora
  i przy rozstrzyganiu, kto może żądać resetu.
- Wpis poczty/Google może mieć zamiast hasła adnotację „hasło znane tylko pracownikowi,
  reset przez panel" — wtedy aplikacja jawnie pokazuje, że nie mamy pełnego dostępu.

## 5. Bezpieczeństwo

### 5.1 Szyfrowanie sekretów

- AES-256-GCM, szyfrowanie **per pole**, losowy nonce per zapis, AAD wiążący rekord
  (id pracownika, kategoria, klucz pola) — podmiana zaszyfrowanej wartości między rekordami
  powoduje błąd odszyfrowania.
- Szyfrowanie kopertowe: klucz główny (KEK) poza bazą — Docker secret / plik poza wolumenem;
  w bazie leży klucz danych (DEK) zaszyfrowany KEK-iem. Umożliwia rotację KEK bez
  przepisywania danych i rotację DEK jako operację administracyjną.
- Brak klucza = aplikacja nie startuje (fail closed), nie „działa bez szyfrowania".
- CLI: `key:rotate-kek`, `key:rotate-dek`, `secret:reencrypt` — każda operacja logowana.

### 5.2 Konta i sesje

- Hasła kont: Argon2id (parametry dobrane do serwera, min. 64 MiB pamięci).
- 2FA TOTP obowiązkowe dla `admin` i `operator` (konfiguracja przy pierwszym logowaniu,
  kody odzyskiwania generowane jednorazowo). Dla `audytor` opcjonalne, ale zalecane.
- Sesje: podpisane cookie HttpOnly + Secure + SameSite=Lax, token hash w bazie,
  wygaśnięcie bezczynności 30 min, absolutne 12 h. Wylogowanie unieważnia sesję.
- CSRF: double-submit token dla mutacji.
- Rate limiting per IP i per konto; blokada konta po 5 nieudanych próbach (15 min),
  zdarzenia w logu audytowym.
- Ponowne potwierdzenie hasła (re-auth) wymagane do: podejrzenia sekretu, zmiany hasła innego
  konta, rotacji kluczy, eksportu pełnej historii.

### 5.3 Podejrzenie sekretu

- Sekrety domyślnie zamaskowane; przycisk „Pokaż" wymaga re-auth.
- Każde podejrzenie = wpis w logu (kto, kiedy, który sekret, IP).
- Wartość widoczna 30 s, potem automatycznie maskowana. Kopiowanie do schowka też jest
  zdarzeniem audytowym (oznaczonym jako „skopiowano").
- Rola `audytor` nie ma prawa podejrzenia — przycisk nie istnieje w UI i endpoint zwraca 403.

### 5.4 Szyfrowanie w spoczynku i kopie

- Sekrety — szyfrowane na poziomie pola (5.1).
- Pozostałe dane (imiona, loginy, jednostki) — plaintext w SQLite; wymagane szyfrowane
  wolumeny hosta / dysk szyfrowany. To świadoma decyzja: pełne szyfrowanie bazy (SQLCipher)
  utrudnia wyszukiwarkę i backup, a nie chroni przed atakującym z dostępem do procesu.
- Kopie zapasowe: `VACUUM INTO` + szyfrowanie AES-256-GCM kluczem backupowym (osobny sekret),
  nazwa z datą, rotacja 30 dni. Skrypt `npm run backup` w kontenerze; kopia kopiowana poza
  serwer (rsync/S3 — konfiguracja wdrożeniowa). Test odtworzenia w CI (na małej bazie).

### 5.5 Nagłówki i powierzchnia ataku

- CSP, HSTS (za TLS), X-Content-Type-Options, Referrer-Policy, Permissions-Policy
  w `next.config.ts → headers()`.
- Brak telemetrii zewnętrznej, brak fontów/CDN z sieci — wszystko self-hosted.
- Kontener: non-root, rootfs read-only, tylko `/data` zapisywalny, healthcheck.

### 5.6 Czego świadomie nie ma w v1

- SSO/LDAP, logowanie przez Google — integracja z zewnętrznym IdP to osobny projekt.
- Szyfrowania end-to-end po stronie przeglądarki (klucz w przeglądarce) — uniemożliwiłoby
  wyszukiwanie i import; nie jest wymagane przy 5 zaufanych kontach w sieci firmowej.

## 6. Audyt i historia

Dwie warstwy, bo audytor pyta o nie inaczej.

### 6.1 Log zdarzeń (append-only, hash chain)

- Tabela `audit_events`: `seq`, czas, aktor, IP, akcja, typ i id encji, zwięzły opis,
  szczegóły zredagowane (bez wartości sekretów), `prev_hash`, `entry_hash`.
- `entry_hash = SHA-256(prev_hash || kanoniczny JSON wpisu)` — podmiana lub usunięcie wpisu
  w środku łańcucha jest wykrywalne.
- Endpoint „Weryfikuj łańcuch" przelicza całość i pokazuje pierwszy uszkodzony wpis.
- Zakres zdarzeń: logowania (udane/nieudane), 2FA, re-auth, CRUD pracownika, dodanie/zmiana/
  wycofanie dostępu, podejrzenie i skopiowanie sekretu, eksport, import, zmiany kont
  aplikacji, rotacja kluczy, backup, weryfikacja łańcucha.
- Log nigdy nie jest czyszczony automatycznie. Retencja = bezterminowa.

### 6.2 Historia rekordu

- Tabela `record_history`: encja, pole, wartość przed, wartość po, autor, czas.
- Dla pól sekretnych wartości są redagowane do znacznika „[zmieniono]" — **historia nie może
  stać się drugą, jawną kopią haseł**.
- Widok „Historia" na kartotece pracownika i na dostępie: chronologiczna lista zmian.
- Eksport CSV/PDF (PDF przez druk przeglądarki) na żądanie audytora, z zaznaczeniem zakresu
  dat i informacją o zredagowanych polach.

Skala: 5 kont, ~30 osób/mies. × kilka edycji → ~30–50 tys. wpisów w 5 lat. SQLite bez
problemu; indeks po (entity_type, entity_id, changed_at) i po czasie.

## 7. Generator haseł

- Domyślnie **8 znaków, małe litery a–z, maksymalnie 3 cyfry**.
- Algorytm: losowanie `crypto.randomInt` (CSPRNG, bez `Math.random`), wybór liczby cyfr
  `d ∈ {0..3}` (domyślnie 2, wybieralne w UI), losowe pozycje cyfr, reszta małe litery;
  gwarancja co najmniej jednej litery.
- Pole „długość" 8–32 (domyślnie 8) i przełącznik „mocny wariant" (wielkie litery + symbole)
  na wypadek, gdy polityka któregoś systemu tego wymaga — bez przebudowy aplikacji.
- Generator dostępny przy każdym polu sekretnym (ikona), z kopiowaniem i ponownym losowaniem.
- Testy: długość, dozwolone znaki, limit cyfr, rozkład (brak oczywistych biasów), brak
  powtórzeń w serii testowej.

## 8. Wyszukiwarka

- Jeden pasek: szuka po imieniu, nazwisku, stanowisku, jednostce, loginach (Axel, bClient,
  poczta, Google), numerze chipa, nazwie dostępu.
- Foldowanie polskich znaków (ą→a itd.) — wzorzec `foldDiacritics` z bakery-chain.
- Wyniki natychmiastowe (debounce 150 ms), podświetlenie trafień, filtr statusu
  (aktywni / archiwum / wszyscy) i filtr kategorii dostępu.
- Implementacja: kolumny znormalizowane + FTS5; przy skali tysięcy rekordów wystarczy
  z zapasem.

## 9. Szybkie dodawanie pracownika

Cel: nowy pracownik z podstawowymi dostępami w **mniej niż 30 sekund**, bez myszy.

- Formularz quick-add: imię, nazwisko, jednostka (wyszukiwane), stanowisko (opcjonalne) —
  Enter zapisuje i otwiera kartotekę w trybie dodawania dostępu.
- Na kartotece: „Dodaj dostęp" → wybór kategorii z listy → dynamiczny formularz pól
  kategorii → zapis. Focus wraca na listę; kolejny dostęp można dodać bez opuszczania
  kartoteki.
- Duplikat pracownika (imię + nazwisko + jednostka) → ostrzeżenie, nie blokada.
- Wszystko na skróty: `n` nowy pracownik, `/` szukaj, `Esc` zamknij.

## 10. Archiwum

- Pracownik ma status `aktywny` / `zarchiwizowany` (data i autor archiwizacji).
- Archiwizacja nie kasuje danych ani historii; wszystkie dostępy pokazują się jako wygasłe.
- Widok przełącznika „Aktywni / Archiwum / Wszyscy". Przywrócenie jednym kliknięciem.
- Twarde usunięcie: **niedostępne w UI**. Tylko CLI `worker:purge` z podwójnym
  potwierdzeniem, logowane — na wypadek żądania RODO.
- Eksport danych pracownika (RODO) — JSON/CSV z metadanymi; sekrety w eksporcie domyślnie
  pominięte, włączenie wymaga re-auth i jest logowane.

## 11. Import z Excela

Zakres v1: **lista użytkowników** (tak jak `konta.xlsx`: login, imię i nazwisko, rola, sklep,
region). Rozbudowa o dostępy w kolejnych iteracjach.

- Kreator: upload `.xlsx` → automatyczne rozpoznanie nagłówków (z podpowiedziami mapowania)
  → mapowanie kolumn (drag/select) → podgląd z walidacją wiersz po wierszu → import.
- Raport: ile dodano, ile pominięto (duplikaty), ile błędów i dlaczego; możliwość pobrania
  raportu CSV. Import w jednej transakcji — albo wszystko, albo nic (z opcją „importuj
  poprawne, pomiń błędne").
- Biblioteka: `exceljs` (MIT). Limit rozmiaru pliku 10 MB, tylko `.xlsx` (nie `.xls`, nie makra).
- Każdy import = wpis w logu audytowym (kto, plik, liczba rekordów).
- Import nie nadpisuje istniejących rekordów bez trybu „aktualizuj po loginie" — domyślnie
  pomija duplikaty.
- Osobny import słownika jednostek (sklepy + przypisanie regionu) — patrz 1a.

## 12. Architektura techniczna

Wzorowana na `bakery-chain`, żeby firma miała jeden znany sposób wdrożenia i utrzymania.

- **Next.js 16** (App Router) + React 19 + Tailwind 4, TypeScript strict.
- **SQLite** (better-sqlite3) + drizzle-orm, tryb WAL, `BEGIN IMMEDIATE` przy mutacjach
  złożonych. Jedna baza, jeden kontener.
- **Vitest** (unit + integracja API na `:memory:`) i **Playwright** (E2E na osobnej bazie
  i porcie). Testy kryptografii: wykrywanie manipulacji, zły klucz, zły AAD.
- **Docker**: multi-stage, `node:24-bookworm-slim`, non-root, rootfs read-only,
  wolumen `/data`. `docker-compose.yml` z sekretami (KEK, klucz backupu) montowanymi
  jako pliki. Reverse proxy z TLS (Caddy) — konfiguracja w `deploy/`.
- Migracje schematu: numerowane pliki SQL w `src/db/migrations/`, aplikowane przy starcie
  w transakcji, wersja w `PRAGMA user_version`.

### Tabele (zarys)

```
app_users        (id, username, display_name, role, password_hash, totp_secret_enc,
                  totp_enabled, failed_attempts, locked_until, is_active, created_at, last_login_at)
sessions         (id, user_id, token_hash, created_at, last_seen_at, expires_at, ip, user_agent)
crypto_keys      (version, wrapped_dek, created_at, retired_at)
org_units        (id, type: region|zaklad|sklep|biuro, name, number, parent_id)
access_categories(id, slug, name, field_schema JSON, sort_order, is_system)
workers          (id, first_name, last_name, position, org_unit_id, email, phone, notes,
                  status, created_at, updated_at, archived_at)
accesses         (id, worker_id, category_id, title, status, resource_owner,
                  created_at, updated_at, created_by, revoked_at)
access_fields    (id, access_id, field_key, value_text NULL, value_enc BLOB NULL,
                  is_secret, owner_kind, key_version)
audit_events     (seq PK, at, actor_user_id, actor_ip, action, entity_type, entity_id,
                  summary, details_json, prev_hash, entry_hash)
record_history   (id, entity_type, entity_id, field_key, old_value, new_value,
                  actor_user_id, changed_at)
```

### API (route handlers)

```
POST /api/auth/login | /2fa | /logout | /reauth
GET  /api/workers?q=&status=&category=
POST /api/workers
GET|PATCH /api/workers/:id
POST /api/workers/:id/archive | /restore
POST /api/workers/:id/accesses
PATCH|DELETE /api/accesses/:id            (DELETE = wycofanie)
POST /api/accesses/:id/reveal
GET  /api/search?q=
GET  /api/audit?from=&to=&actor=&action=
GET  /api/audit/verify
GET  /api/audit/export
POST /api/import/preview | /commit
GET|POST /api/admin/users
GET|POST /api/admin/org-units
GET|POST /api/admin/categories
```

## 13. Ekrany

1. **Logowanie** — login, hasło, 2FA; komunikat o blokadzie.
2. **Pracownicy** — pasek szukania, przełącznik Aktywni/Archiwum/Wszyscy, filtr kategorii,
   lista z najważniejszymi dostępami, quick-add (`n`).
3. **Kartoteka** — dane osoby, karty dostępów per kategoria, „Dodaj dostęp", historia,
   archiwizacja, eksport RODO.
4. **Audyt** — log z filtrami, weryfikacja łańcucha, eksport.
5. **Import** — kreator 4 kroków.
6. **Administracja** — konta, jednostki organizacyjne, kategorie dostępów, klucze (rotacja),
   backup (instrukcja + ostatni status).
7. **Moje konto** — zmiana hasła, 2FA, kody odzyskiwania.

UI po polsku, ciemny/jasny motyw, układ gęsty (to narzędzie pracy, nie landing page).

## 14. Wdrożenie i dostępność

- `docker compose up -d` + Caddy z automatycznym TLS. Restart policy `unless-stopped`,
  healthcheck `/api/health`.
- „Dostępne zawsze" przy 5 użytkownikach = brak Single Point of Failure poza samym serwerem:
  SQLite WAL, szybki restart, kopie poza serwerem, procedura odtworzenia opisana i
  przetestowana. Klastra/HA nie projektujemy — to świadomy non-goal.
- Monitoring podstawowy: log kontenera + healthcheck + dzienny backup z alertem przy błędzie
  (skrypt exit code + cron mail/systemd).

## 15. Testy i jakość

- TDD: testy przed implementacją dla kryptografii, generatora, łańcucha audytu, importu,
  walidacji pól kategorii.
- Integracja: każde API (uprawnienia ról, CSRF, rate limit, redakcja sekretów w odpowiedziach).
- E2E: logowanie + 2FA → dodanie pracownika → dodanie chipa i Axela → podejrzenie hasła
  (wpis w audycie) → archiwizacja → import z Excela → eksport audytu.
- Test „brak wycieku": żaden endpoint nie zwraca `value_enc`, `password_hash`, `totp_secret_enc`;
  odpowiedzi API nie zawierają sekretów bez jawnej akcji reveal.
- Test odtworzenia backupu na czystej bazie w CI.
- Lint + `tsc --noEmit` + build w CI (GitHub Actions).

## 16. Non-goals v1

- Portal dla pracowników, samoobsługa, aplikacja mobilna.
- Automatyczna synchronizacja z pięcioma systemami (tylko import/eksport plików).
- SSO/LDAP, integracja z Google Workspace.
- Wielodostępność (multi-tenant), wiele firm.
- HA/klaster, replikacja bazy.
- Szyfrowanie end-to-end po stronie przeglądarki.

## 17. Decyzje podjęte przez wykonawcę (do sprawdzenia)

1. SQLite zamiast Postgresa — przy 5 użytkownikach prostszy backup i wdrożenie; wzorzec
   znany z bakery-chain.
2. Szyfrowanie per pole z kopertą kluczy (KEK/DEK) zamiast szyfrowania całej bazy.
3. Historia zmian bez wartości haseł (redakcja) — inaczej log byłby drugą kopią haseł.
4. Dwie role edycyjne (admin/operator) + audytor tylko do odczytu.
5. 2FA obowiązkowe dla admina i operatora.
6. Generator domyślnie 8 znaków / maks. 3 cyfry, ale z polem długości i „mocnym wariantem".
7. Import v1 = lista użytkowników, kreator z mapowaniem kolumn (rozszerzalny później).
8. Archiwizacja zamiast kasowania; twarde usunięcie tylko CLI.
9. Stack i konwencje jak w bakery-chain (Next 16, Vitest, Playwright, Docker).
10. Numer sklepu w `org_units` opcjonalny (49/124 wierszy wykazu go nie ma).

## 18. Ustalenia z przeglądu projektu (pytania wykonawcy — rozstrzygnięte)

Przegląd „świeżego" wykonawcy wykrył miejsca, w których dokument wymagał doprecyzowania.
Poniższe punkty są decyzjami wykonawcy; zmieniają szczegóły implementacji, nie zakres produktu.

1. **Pola wielowartościowe** (poziomy chipa) — `access_fields` przechowuje jedną wartość na
   wiersz; typ pola w `field_schema` (`text`, `password`, `select`, `multiselect`, `date`,
   `ref_org_unit`) decyduje o walidacji i renderowaniu. Multiselect = wiele wierszy z tym
   samym `field_key`, wartości kanoniczne (`piekarnia`, `cukiernia`, `biura`, `pierogarnia`,
   `alarm`).
2. **Historia a tworzenie/usuwanie** — `record_history` obejmuje zmiany pól istniejących
   encji; utworzenie, archiwizacja, przywrócenie i wycofanie dostępu są zdarzeniami
   w `audit_events` (z pełnym kontekstem), więc nie duplikujemy ich w historii pól.
3. **Pierwsze konto admina** — hasło losowane przy starcie, wypisane **wyłącznie do logu
   kontenera** (nie do pliku w wolumenie), z wymuszoną zmianą i konfiguracją 2FA przy
   pierwszym logowaniu.
4. **TOTP** — sekret TOTP szyfrowany tym samym mechanizmem kopertowym co pozostałe sekrety,
   z osobnym AAD (`app_user:<id>:totp`).
5. **Import a jednostki organizacyjne** — w kroku podglądu każda nieznana jednostka z Excela
   wymaga decyzji: mapuj na istniejącą albo utwórz nową (typ `sklep`/`zaklad`). Import nie
   tworzy jednostek po cichu.
6. **Kolumna „rola" w `konta.xlsx`** — to rola w firmie (`employee`, `manager`, …), a nie rola
   w tej aplikacji. Import trafia do pola `position`; role aplikacyjne nadaje się tylko
   w Administracji. Zapobiega to przypadkowemu nadaniu uprawnień z pliku.
7. **Kategorie systemowe** — `field_schema` kategorii systemowych (chip, axel, bClient,
   dostęp zdalny, monitoring, poczta, Google) jest stały; administracja może zmieniać nazwy
   wyświetlane i kolejność. Kategoria „inne" pozwala definiować własne pola.
8. **Reveal** — wartość jest odsyłana jednorazowo w odpowiedzi; automatyczne maskowanie po
   30 s jest po stronie klienta, serwer nie przechowuje stanu „odkrycia". Każde żądanie
   reveal to osobny wpis w audycie (także ponowne odkrycie po 30 s).
9. **Backup** — klucz backupowy jest osobnym sekretem od KEK; rotacja klucza backupowego
   nie jest częścią v1 (kopie i tak są odtwarzane kluczem aktualnym w chwili tworzenia).
10. **Zakres importu v1** — tylko `.xlsx` z jednym arkuszem; wiele arkuszy i `.csv` poza
    zakresem, ale kreator jest zaprojektowany tak, by dodanie ich nie wymagało zmian schematu.

---

## 19. Stan implementacji (2026-11-25)

Dokument powyżej jest projektem; ta sekcja opisuje, co faktycznie powstało i czym
implementacja różni się od pierwotnych założeń. **Stan: v1 kompletne i przetestowane.**

### 19.1 Co działa

| Obszar | Status | Uwagi |
| --- | --- | --- |
| Kartoteka pracowników (CRUD, archiwum, przywracanie) | ✅ | Lista + kartoteka, wyszukiwarka odporna na polskie znaki |
| Dostępy i sekrety (7 kategorii + „inne") | ✅ | Szyfrowanie per pole, reveal z 30-sekundowym oknem i audytem |
| Generator haseł | ✅ | 8 znaków, małe litery, maks. 3 cyfry (parametry konfigurowalne) |
| 2FA (TOTP) + kody odzyskiwania | ✅ | Wymuszane dla admina/operatora, reset przez administratora |
| Sesje, CSRF, rate limit, blokada konta | ✅ | Idle 30 min, absolute 12 h, step-up reauth 5 min |
| Audyt append-only z hash chain | ✅ | Weryfikacja łańcucha, eksport CSV, komplet etykiet |
| Import z Excela | ✅ | Kreator 4-krokowy, rozwiązywanie jednostek, licznik z serwera |
| Administracja (konta, jednostki, kategorie, klucze) | ✅ | Twardy limit 5 kont, reset hasła i 2FA |
| Kopie zapasowe + rotacja KEK | ✅ | `VACUUM INTO` + AES-256-GCM, retencja 14 kopii |
| Docker + Caddy (auto-TLS) | ✅ | Trzyetapowy build, użytkownik nieuprzywilejowany, `no-new-privileges` |

### 19.2 Migracje bazy

| Wersja | Plik | Zawartość |
| --- | --- | --- |
| v1 | `001_init.sql` | Wszystkie tabele, triggery append-only na `audit_events` |
| v2 | `002_seed_categories.sql` | 7 kategorii systemowych z definicjami pól (JSON) |
| v3 | `003_session_reauth.sql` | `sessions.reauth_at` — okno step-up dla podejrzenia sekretu |

Migracje stosuje `src/db/index.ts` przy pierwszym połączeniu, w transakcji, po numerze
w nazwie pliku. `PRAGMA user_version` jest jedynym źródłem prawdy o wersji schematu.

### 19.3 Model uwierzytelniania — szczegóły wykraczające poza projekt

- **Sesja oczekująca na 2FA** (`pending_2fa`) istnieje w bazie, ale `requireUser()`
  odrzuca ją kodem `pending_2fa`. Nie jest to „sesja bez uprawnień" — to token, który
  może wyłącznie dokończyć logowanie.
- **Step-up reauth** — podejrzenie sekretu wymaga potwierdzenia hasła w oknie 5 minut
  (`sessions.reauth_at`). Okno jest per sesja, nie per użytkownik.
- **Blokada konta** to dwa niezależne mechanizmy: licznik `failed_attempts` w bazie
  (5 prób → 15 min, przeżywa restart) oraz rate limit per konto i per IP w pamięci
  procesu (5/15 min i 10/5 min). Oba odpowiadają kodem `locked`/`rate_limited`.
- **Reset 2FA przez administratora** — endpoint `PATCH /api/admin/users/[id]` z
  `resetTotp: true`. Własnego 2FA nie da się zdjąć tą drogą (kod `self_totp`); do tego
  służy świadome `DELETE /api/account/2fa`.

### 19.4 Import — licznik `importable`

Pierwotny projekt zakładał, że przycisk importu pokaże `summary.ok`. To było błędne:
wiersze ze statusem „uwaga" też są importowane, jeśli mają rozpoznaną jednostkę.
Serwer liczy więc `importable` dokładnie tak, jak zrobi to `commitImport`, a kreator
pokazuje tę liczbę i blokuje przycisk, gdy wynosi 0. Zmiana przypisania jednostki
odświeża podgląd, bo liczba zależy od decyzji operatora.

### 19.5 Testy

| Warstwa | Liczba | Zakres |
| --- | --- | --- |
| Integracyjne (Vitest) | 195 | API, sesje, role, szyfrowanie, audyt, import, generator, migracje |
| Operacyjne (Vitest) | 15 | `scripts/backup.cjs` i `restore.cjs` jako osobne procesy: round-trip, retencja, ścieżki błędów |
| E2E funkcjonalne (Playwright) | 69 | Logowanie, 2FA, role, audyt, import, administracja, konto |
| Wizualne (Playwright) | 10 | Zrzuty kluczowych ekranów, kontrast awatarów, szerokość strony i mobilnej tabeli |
| Build + typy + lint | — | `tsc --noEmit`, `next build`, ESLint (0 błędów) |

E2E testuje **build produkcyjny za TLS** (`e2e/server.mjs`), bo aplikacja ustawia
cookie `Secure`, a Chromium odrzuca takie cookies po HTTP. Testy dzielą jedną bazę,
więc każdy plik specy przywraca stan seeda (`restoreAccounts`), a każdy test dostaje
własny adres IP dla rate limitu.

Testy operacyjne uruchamiają skrypty jako **osobne procesy** (`spawnSync`), bo tak
działają na produkcji — własny `process.env`, własne `process.exit()`, własne pliki
tymczasowe. Importowanie ich do procesu Vitest fałszywałoby obraz. Każdy test ma
własny katalog tymczasowy i losowane klucze KEK/backup, więc nie dzielą stanu.

### 19.6 Znalezione i naprawione defekty (wykryte przez E2E, nieobecne w testach jednostkowych)

1. **Trwała blokada konta z hasłem startowym** — formularz wymuszonej zmiany hasła nie
   wysyłał nagłówka `X-CSRF-Token`, więc każde nowe konto dostawało 403 i nie mogło
   nigdy ustawić własnego hasła. Naprawione w `src/app/login/page.tsx`.
2. **Fałszywy licznik importu** — przycisk pokazywał inną liczbę, niż faktycznie
   wchodziło do bazy (patrz 19.4).
3. **Biały ekran po imporcie z pominiętymi wierszami** — klient typował `errors` jako
   `string[]`, a serwer zwraca `{rowNumber, message}[]`; renderowanie obiektu jako
   dziecka Reacta wywalało całą stronę na 500 **po** udanym imporcie, co groziło
   powtórnym importem i duplikatami.
4. **Brak etykiet 7 akcji audytu** — audytor widział surowe sluga (`backup.created`).
   Etykiety przeniesione do `src/lib/audit/labels.ts` z testem kompletności.
5. **Brak resetu 2FA w panelu** — osoba, która zgubiła telefon i kody, była trwale
   odcięta. Dodany endpoint + przycisk + wpis audytu.

### 19.7 Znane ograniczenia

- **Brak CSRF na `next.config.ts` headers** — CSP używa `'unsafe-inline'` dla skryptów
  (wymóg hydratacji Nexta). Nonce to przyszłe ulepszenie, nie luka w obecnym modelu
  (brak treści od użytkowników, brak CDN).
- **Rate limit w pamięci procesu** — przy jednym kontenerze jest poprawny; przy
  skalowaniu poziomym trzeba by przenieść liczniki do bazy lub Redisa.
- **Brak CI** — plik workflow nie powstał; wszystkie polecenia weryfikacyjne są
  opisane w `AGENTS.md` i uruchamiane lokalnie.
- **Obraz Dockera nie został zbudowany w tym środowisku** — brak dostępu do registry
  (`DeadlineExceeded` przy pobieraniu `docker/dockerfile`). Zweryfikowano natomiast
  artefakt standalone, `docker compose config` (kod wyjścia 0) oraz pełny cykl
  operacyjny bez Dockera: `db:init` → `backup` → `restore` → `rekey:dek`.
- **Restore nie jest uruchamiany na kopii produkcyjnej** — logika backupu i odtworzenia
  jest pokryta testami (`tests/ops/backup-restore.test.ts`), ale nikt nie odtwarza
  cyklicznie prawdziwej kopii z `deploy/`. Warto dorzucić okresowy job, który odtwarza
  ostatnią kopię do katalogu tymczasowego i porównuje liczniki.

### 19.8 Defekty w skryptach operacyjnych (znalezione przy automatyzacji testów)

Testy operacyjne powstały po to, by procedura „opisana, ale nigdy nieuruchamiana
automatycznie” przestała być tylko nadzieją. Przy ich pisaniu wyszły cztery defekty —
wszystkie w `scripts/`, żaden w aplikacji:

1. **Kopie nadpisywały się w tej samej sekundzie.** Znacznik czasu był ucinany do
   sekund (`slice(0, 19)`), więc druga kopia w tej samej sekundzie dostawała tę samą
   nazwę. Przy szyfrowaniu plik `.enc` był cicho nadpisywany; bez szyfrowania
   `VACUUM INTO` odmawiało zapisu do istniejącego pliku. Trzy kopie → jeden plik.
   Naprawione: milisekundy + `lib.uniqueBase()` dokładające `-2`, `-3`… i sprawdzające
   oba warianty końcówki.
2. **Kopie szyfrowane nigdy nie były weryfikowane.** `backup.cjs` sprawdzał kopię tylko
   wtedy, gdy nie było klucza backupu — czyli **nigdy w konfiguracji produkcyjnej**.
   Teraz weryfikacja obejmuje też plik `.enc` (odszyfrowanie do katalogu tymczasowego
   i pełne sprawdzenie), a log jawnie to potwierdza.
3. **Odszyfrowana baza zostawała po nieudanym restore.** `lib.fail()` kończy proces
   przez `process.exit()`, co **nie uruchamia bloków `finally`** — katalog tymczasowy
   z jawną bazą (wszystkie sekrety) przeżywał błąd walidacji. Teraz oczekiwane błędy
   są rzucane (`ScriptError`), a sprzątanie działa także przy błędzie.
4. **Retencja mogła usunąć świeżą kopię.** `USERBASE_BACKUP_KEEP=0` (albo literówka
   w zmiennej) usuwała wszystko, w tym kopię właśnie utworzoną. Teraz wartość mniejsza
   od 1 spada na domyślne 14.

Przy okazji potwierdzono eksperymentalnie, że `VACUUM INTO` daje plik kompletny bez
sidecara `-wal` — wiersze zapisane tuż przed kopią są w środku. Kopiowanie samego `.db`
po `VACUUM INTO` jest poprawne; wcześniejszy komentarz sugerujący inaczej był błędny.

### 19.9 Przegląd wizualny

Przegląd obejmuje rzeczywiste zrzuty Playwright z builda produkcyjnego: logowanie,
listę pracowników, kartotekę, audyt, import, administrację kontami i jednostkami,
moje konto, listę w motywie jasnym i telefon 390 × 844. Kierunek „graphite + amber”
pozostaje bez zmiany architektury ani zależności.

Potwierdzone defekty i decyzje:

- **Słabo widoczne opisy pomocnicze.** `--ub-text-dim` miało kontrast 3.46:1 na
  najjaśniejszym ciemnym tle i 2.66:1 na jasnym tle `hover`. Nowe wartości
  `#8490a5` / `#656e85` dają odpowiednio minimum 4.92:1 / 4.55:1 na pięciu
  podstawowych powierzchniach. To pomiar tokenów, nie deklaracja pełnego audytu WCAG.
- **Akcent w motywie jasnym.** Inicjały na półprzezroczystym bursztynowym tle miały
  około 3.29:1. Ciemniejszy bursztyn `#8f5d00` daje około 5.03:1; tekst przycisku
  głównego jest biały (5.62:1, a w hover 7.13:1). Osobne tokeny
  `--ub-accent-text` i `--ub-btn-primary-text` opisują ich role.
- **Filtry daty audytu.** Pola mają widoczne etykiety „Od” i „Do”. Pozostają natywne
  kontrolki daty: format pustego pola zależy od przeglądarki/systemu, a wartość
  wysyłana do API zachowuje format ISO.
- **Kolumna dostępów na telefonie.** Długie nazwisko wypychało zawartość tabeli
  do 481 px w karcie szerokości 356 px. Sama asercja szerokości strony tego nie
  wykrywała. `table-fixed` poniżej `sm`, wydzielona szerokość dostępów i skracanie
  nazwiska rozwiązują problem; pełna nazwa pozostaje w tekście linku i kartotece.
- **Dane do zrzutów.** Usunięto wymuszanie duplikatów podczas seedowania, dostępów
  szuka się przez kartotekę, a mobilny zrzut obejmuje viewport ze stałą nawigacją.
  Uruchomienie samego speca daje czyste dane demonstracyjne; pełny zestaw testów
  pozostawia także rekordy funkcjonalne z syntetycznymi nazwami.

Ocena końcowego układu: lista jest głównym elementem ekranu, wyszukiwanie i dodawanie
są dostępne nad nią, pola i opisy zachowują wspólne krawędzie; motyw jasny zachowuje
hierarchię bez słabo czytelnych inicjałów. Telefon pokazuje dwie kolumny i dolną
nawigację. Administracja i konto są celowo krótsze od wysokości okna przy limicie
pięciu kont. Audyt pozostaje gęsty (maks. 200 wczytanych wpisów); stronicowanie
starszych zdarzeń wymaga dalszej pracy. Eksport obejmuje dane według API.
