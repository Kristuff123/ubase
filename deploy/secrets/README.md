# Sekrety wdrożenia

Ten katalog zawiera klucze kryptograficzne. **Nigdy nie commituj ich do repozytorium.**

## Pliki

| Plik | Przeznaczenie |
|------|---------------|
| `kek` | Klucz główny (KEK) — 32 bajty w base64. Bez niego baza jest nieczytelna. |
| `backup_key` | Klucz szyfrowania kopii zapasowych — 32 bajty w base64. |

## Generowanie

```bash
mkdir -p deploy/secrets
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > deploy/secrets/kek
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))" > deploy/secrets/backup_key
chmod 600 deploy/secrets/kek deploy/secrets/backup_key
```

## Przechowywanie

Oba klucze trafiają do sejfu (1Password, Bitwarden, Vault) **poza serwerem**.
Kopia zapasowa bez klucza `backup_key` jest bezużyteczna — klucz musi być
dostępny nawet w scenariuszu „serwer spłonął”.

**Utrata `kek` = utrata wszystkich haseł w bazie.** Hasła kont aplikacji
są hashowane Argon2id (nieodwracalne), ale sekrety dostępów są szyfrowane
AES-256-GCM kluczem danych opakowanym przez KEK.
