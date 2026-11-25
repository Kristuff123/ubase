/**
 * Polskie etykiety akcji audytu.
 *
 * Trzymane osobno od widoku, żeby dało się ich kompletność sprawdzić testem
 * względem unii `AuditAction` — brak etykiety oznacza surowy slug w tabeli,
 * czyli dokładnie to, czego audytor nie powinien oglądać.
 */
import type { AuditAction } from "@/lib/audit/log";

export const ACTION_LABELS: Record<AuditAction, string> = {
  // Uwierzytelnianie
  "auth.login": "Logowanie",
  "auth.login_failed": "Nieudane logowanie",
  "auth.logout": "Wylogowanie",
  "auth.2fa": "Kod 2FA",
  "auth.2fa_failed": "Nieudany kod 2FA",
  "auth.reauth": "Potwierdzenie hasła",
  "auth.reauth_failed": "Nieudane potwierdzenie hasła",
  "auth.lockout": "Blokada konta",
  "auth.password_changed": "Zmiana hasła",
  "auth.totp_enrolled": "2FA — zmiana",
  "auth.totp_reset": "Reset 2FA",
  "auth.recovery_codes_viewed": "Podgląd kodów odzyskiwania",

  // Konta aplikacji
  "user.created": "Utworzenie konta",
  "user.updated": "Zmiana konta",
  "user.deactivated": "Wyłączenie konta",

  // Pracownicy
  "worker.created": "Dodanie pracownika",
  "worker.updated": "Zmiana danych pracownika",
  "worker.archived": "Archiwizacja",
  "worker.restored": "Przywrócenie",
  "worker.exported": "Eksport danych",
  "worker.purged": "Trwałe usunięcie danych",

  // Dostępy i sekrety
  "access.created": "Dodanie dostępu",
  "access.updated": "Zmiana dostępu",
  "access.revoked": "Wycofanie dostępu",
  "secret.revealed": "Podejrzenie sekretu",
  "secret.copied": "Skopiowanie sekretu",

  // Administracja słownikami
  "admin.org_unit.created": "Nowa jednostka",
  "admin.org_unit.updated": "Zmiana jednostki",
  "admin.category.created": "Nowa kategoria",
  "admin.category.updated": "Zmiana kategorii",

  // Import
  "import.previewed": "Podgląd importu",
  "import.committed": "Import wykonany",

  // Audyt i operacje systemowe
  "audit.verified": "Weryfikacja audytu",
  "audit.exported": "Eksport logu",
  "backup.created": "Kopia zapasowa",
  "key.rotated": "Rotacja klucza",
};
