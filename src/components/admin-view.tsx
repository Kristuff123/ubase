"use client";

/**
 * Administracja: konta aplikacji (max 5), jednostki organizacyjne, kategorie dostępów, klucze.
 * Wszystko za rolą admin — serwer dodatkowo weryfikuje uprawnienia w API.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import type { FieldDef } from "@/lib/domain/types";
import { ApiError, api } from "@/lib/client";
import { formatDate, formatDateTime } from "@/lib/utils";
import { toast } from "@/components/toast";

type AppUser = {
  id: number;
  username: string;
  display_name: string;
  role: "admin" | "operator" | "audytor";
  totp_enabled: number;
  is_active: number;
  created_at: number;
  last_login_at: number | null;
};

type Unit = { id: number; type: string; name: string; number: string | null; parent_id: number | null; is_active: number };
type Category = { id: number; slug: string; name: string; sort_order: number; is_active: number; fields: FieldDef[] };

const ROLE_LABELS: Record<string, string> = {
  admin: "Administrator",
  operator: "Operator",
  audytor: "Audytor",
};

const ROLE_DESCRIPTIONS: Record<string, string> = {
  admin: "Pełny dostęp: konta, jednostki, kategorie, sekrety.",
  operator: "Dodaje i edytuje pracowników oraz dostępy, widzi sekrety.",
  audytor: "Tylko odczyt — bez sekretów i bez zmian (rola kontrolna).",
};

type Tab = "konta" | "jednostki" | "kategorie" | "klucze";

export function AdminView({
  currentUserId,
  users: initialUsers,
  units: initialUnits,
  categories: initialCategories,
  keys,
}: {
  currentUserId: number;
  users: AppUser[];
  units: Unit[];
  categories: Category[];
  keys: { version: number; created_at: number; retired_at: number | null }[];
}) {
  const router = useRouter();
  const [tab, setTab] = useState<Tab>("konta");

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-5">
        <h1 className="text-[20px] font-semibold tracking-tight">Administracja</h1>
        <p className="mt-0.5 text-[12.5px] text-[var(--ub-text-dim)]">
          Konta dostępu do aplikacji, struktura firmy i definicje kategorii.
        </p>
      </header>

      <div className="mb-5 flex gap-1 overflow-x-auto border-b border-[var(--ub-border)]">
        {(
          [
            ["konta", `Konta (${initialUsers.filter((user) => user.is_active === 1).length}/5)`],
            ["jednostki", `Jednostki (${initialUnits.filter((unit) => unit.is_active === 1).length})`],
            ["kategorie", `Kategorie (${initialCategories.filter((category) => category.is_active === 1).length})`],
            ["klucze", "Klucze"],
          ] as [Tab, string][]
        ).map(([value, label]) => (
          <button
            key={value}
            type="button"
            onClick={() => setTab(value)}
            className={`-mb-px whitespace-nowrap border-b-2 px-3 py-2 text-[12.5px] transition-colors ${
              tab === value
                ? "border-[var(--ub-accent)] font-medium text-[var(--ub-text)]"
                : "border-transparent text-[var(--ub-text-dim)] hover:text-[var(--ub-text-muted)]"
            }`}
          >
            {label}
          </button>
        ))}
      </div>

      {tab === "konta" && <UsersTab currentUserId={currentUserId} users={initialUsers} onChanged={() => router.refresh()} />}
      {tab === "jednostki" && <UnitsTab units={initialUnits} onChanged={() => router.refresh()} />}
      {tab === "kategorie" && <CategoriesTab categories={initialCategories} onChanged={() => router.refresh()} />}
      {tab === "klucze" && <KeysTab keys={keys} />}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UsersTab({ currentUserId, users, onChanged }: { currentUserId: number; users: AppUser[]; onChanged: () => void }) {
  const [creating, setCreating] = useState(false);
  const [username, setUsername] = useState("");
  const [displayName, setDisplayName] = useState("");
  const [role, setRole] = useState<"admin" | "operator" | "audytor">("operator");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [newPassword, setNewPassword] = useState<string | null>(null);

  const activeCount = users.filter((user) => user.is_active === 1).length;

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ id: number; password?: string }>("/api/admin/users", {
        body: { username, displayName, role },
      });
      setNewPassword(data.password ?? null);
      toast("Konto utworzone");
      setUsername("");
      setDisplayName("");
      onChanged();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Nie udało się utworzyć konta");
    } finally {
      setBusy(false);
    }
  };

  const patch = async (id: number, body: Record<string, unknown>, message: string) => {
    setBusy(true);
    try {
      const data = await api<{ password?: string }>(`/api/admin/users/${id}`, { method: "PATCH", body });
      if (data.password) setNewPassword(data.password);
      toast(message);
      onChanged();
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : "Operacja nie powiodła się", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      {newPassword && (
        <div className="rounded-[var(--ub-radius)] border border-[rgba(240,180,41,0.4)] bg-[var(--ub-accent-soft)] px-4 py-3">
          <p className="text-[12px] font-medium text-[var(--ub-accent-text)]">
            Hasło startowe — przekaż je bezpiecznym kanałem. Zniknie po odświeżeniu strony.
          </p>
          <p className="ub-mono mt-1 text-[16px] tracking-wide text-[var(--ub-text)]">{newPassword}</p>
          <p className="mt-1 text-[11px] text-[var(--ub-text-dim)]">Konto wymusi zmianę hasła przy pierwszym logowaniu.</p>
        </div>
      )}

      <div className="ub-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--ub-border)] text-left">
              <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Konto</th>
              <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Rola</th>
              <th className="hidden px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] sm:table-cell">2FA</th>
              <th className="hidden px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] md:table-cell">Ostatnie logowanie</th>
              <th className="px-4 py-2.5" />
            </tr>
          </thead>
          <tbody className="ub-divide">
            {users.map((user) => (
              <tr key={user.id} className={user.is_active === 0 ? "opacity-50" : ""}>
                <td className="px-4 py-2.5">
                  <div className="text-[13px] font-medium">{user.display_name}</div>
                  <div className="ub-mono text-[11px] text-[var(--ub-text-dim)]">{user.username}</div>
                </td>
                <td className="px-4 py-2.5">
                  <select
                    value={user.role}
                    disabled={busy || user.id === currentUserId}
                    onChange={(event) => void patch(user.id, { role: event.target.value }, "Rola zmieniona")}
                    className="ub-input w-auto py-1 text-[11.5px]"
                    aria-label={`Rola ${user.username}`}
                  >
                    {Object.entries(ROLE_LABELS).map(([value, label]) => (
                      <option key={value} value={value}>
                        {label}
                      </option>
                    ))}
                  </select>
                </td>
                <td className="hidden px-4 py-2.5 sm:table-cell">
                  {user.totp_enabled === 1 ? (
                    <span className="ub-chip ub-chip-ok">włączone</span>
                  ) : (
                    <span className="ub-chip ub-chip-warn">brak</span>
                  )}
                </td>
                <td className="hidden px-4 py-2.5 md:table-cell text-[11.5px] text-[var(--ub-text-dim)]">
                  {user.last_login_at ? formatDateTime(user.last_login_at) : "nigdy"}
                </td>
                <td className="px-4 py-2.5 text-right">
                  <div className="flex justify-end gap-1">
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => {
                        if (window.confirm(`Zresetować hasło ${user.username}?`)) {
                          void patch(user.id, { resetPassword: true }, "Hasło zresetowane");
                        }
                      }}
                      className="ub-btn ub-btn-ghost px-2 py-1 text-[11px]"
                    >
                      reset hasła
                    </button>
                    {user.totp_enabled === 1 && user.id !== currentUserId && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() => {
                          if (
                            window.confirm(
                              `Zresetować 2FA konta ${user.username}? Osoba będzie logować się bez kodu, dopóki nie włączy 2FA ponownie.`,
                            )
                          ) {
                            void patch(user.id, { resetTotp: true }, "2FA zresetowane");
                          }
                        }}
                        className="ub-btn ub-btn-ghost px-2 py-1 text-[11px] text-[var(--ub-warn)]"
                      >
                        reset 2FA
                      </button>
                    )}
                    {user.id !== currentUserId && (
                      <button
                        type="button"
                        disabled={busy}
                        onClick={() =>
                          void patch(
                            user.id,
                            { isActive: user.is_active === 1 ? false : true },
                            user.is_active === 1 ? "Konto wyłączone" : "Konto włączone",
                          )
                        }
                        className={`ub-btn ub-btn-ghost px-2 py-1 text-[11px] ${user.is_active === 1 ? "text-[var(--ub-danger)]" : "text-[var(--ub-ok)]"}`}
                      >
                        {user.is_active === 1 ? "wyłącz" : "włącz"}
                      </button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        <div className="border-t border-[var(--ub-border)] px-4 py-2.5 text-[11px] text-[var(--ub-text-dim)]">
          Aktywne konta: {activeCount} z 5 przewidzianych. {!creating && activeCount < 5 && (
            <button type="button" onClick={() => setCreating(true)} className="text-[var(--ub-accent-text)] hover:underline">
              Dodaj konto
            </button>
          )}
        </div>
      </div>

      {creating && (
        <form onSubmit={create} className="ub-card p-4">
          <p className="ub-panel-title mb-3">Nowe konto</p>
          <div className="grid gap-3 sm:grid-cols-3">
            <div>
              <label htmlFor="nu-login" className="ub-label">Login</label>
              <input id="nu-login" value={username} onChange={(event) => setUsername(event.target.value)} required className="ub-input" placeholder="jkowalski" />
            </div>
            <div>
              <label htmlFor="nu-name" className="ub-label">Imię i nazwisko</label>
              <input id="nu-name" value={displayName} onChange={(event) => setDisplayName(event.target.value)} required className="ub-input" />
            </div>
            <div>
              <label htmlFor="nu-role" className="ub-label">Rola</label>
              <select id="nu-role" value={role} onChange={(event) => setRole(event.target.value as typeof role)} className="ub-input">
                {Object.entries(ROLE_LABELS).map(([value, label]) => (
                  <option key={value} value={value}>{label}</option>
                ))}
              </select>
            </div>
          </div>
          <p className="mt-2 text-[11px] text-[var(--ub-text-dim)]">{ROLE_DESCRIPTIONS[role]}</p>
          {error && <p className="mt-2 text-[12px] text-[var(--ub-danger)]">{error}</p>}
          <div className="mt-3 flex gap-2">
            <button type="submit" disabled={busy} className="ub-btn ub-btn-primary">
              {busy ? "Tworzenie…" : "Utwórz konto"}
            </button>
            <button type="button" onClick={() => setCreating(false)} className="ub-btn ub-btn-secondary">
              Anuluj
            </button>
          </div>
        </form>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function UnitsTab({ units, onChanged }: { units: Unit[]; onChanged: () => void }) {
  const [type, setType] = useState<"sklep" | "zaklad" | "biuro" | "region">("sklep");
  const [name, setName] = useState("");
  const [number, setNumber] = useState("");
  const [filter, setFilter] = useState("");
  const [busy, setBusy] = useState(false);

  const grouped = (["zaklad", "biuro", "region", "sklep"] as const).map((unitType) => ({
    type: unitType,
    label: { zaklad: "Zakłady", biuro: "Biura", region: "Regiony", sklep: "Sklepy" }[unitType],
    items: units
      .filter((unit) => unit.type === unitType)
      .filter((unit) => !filter || unit.name.toLowerCase().includes(filter.toLowerCase()) || (unit.number ?? "").includes(filter))
      .sort((a, b) => a.name.localeCompare(b.name, "pl")),
  }));

  const create = async (event: React.FormEvent) => {
    event.preventDefault();
    setBusy(true);
    try {
      await api("/api/admin/org-units", { body: { type, name, number: number || null } });
      toast("Jednostka dodana");
      setName("");
      setNumber("");
      onChanged();
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : "Nie udało się dodać jednostki", "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="space-y-4">
      <form onSubmit={create} className="ub-card p-4">
        <p className="ub-panel-title mb-3">Nowa jednostka</p>
        <div className="grid gap-3 sm:grid-cols-[150px_1fr_140px_auto]">
          <select value={type} onChange={(event) => setType(event.target.value as typeof type)} className="ub-input">
            <option value="sklep">Sklep</option>
            <option value="zaklad">Zakład</option>
            <option value="biuro">Biuro</option>
            <option value="region">Region</option>
          </select>
          <input value={name} onChange={(event) => setName(event.target.value)} required placeholder="Nazwa" className="ub-input" aria-label="Nazwa jednostki" />
          <input value={number} onChange={(event) => setNumber(event.target.value)} placeholder="Numer (opcj.)" className="ub-input" aria-label="Numer" />
          <button type="submit" disabled={busy} className="ub-btn ub-btn-primary">
            Dodaj
          </button>
        </div>
      </form>

      <input
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        placeholder="Filtruj jednostki…"
        className="ub-input max-w-sm"
        aria-label="Filtruj jednostki"
      />

      <div className="grid gap-3 md:grid-cols-2">
        {grouped.map((group) => (
          <div key={group.type} className="ub-card overflow-hidden">
            <div className="border-b border-[var(--ub-border)] px-3.5 py-2">
              <span className="text-[12px] font-semibold">{group.label}</span>
              <span className="ml-1.5 text-[11px] text-[var(--ub-text-dim)]">{group.items.length}</span>
            </div>
            <ul className="max-h-64 overflow-y-auto">
              {group.items.length === 0 && <li className="px-3.5 py-3 text-[11.5px] text-[var(--ub-text-dim)]">Brak.</li>}
              {group.items.map((unit) => (
                <li key={unit.id} className="flex items-center justify-between gap-2 border-b border-[var(--ub-border)] px-3.5 py-1.5 last:border-0">
                  <span className="truncate text-[12px]">
                    {unit.number && <span className="ub-mono mr-1.5 text-[11px] text-[var(--ub-text-dim)]">{unit.number}</span>}
                    {unit.name}
                  </span>
                  {unit.is_active === 0 && <span className="ub-chip">nieaktywna</span>}
                </li>
              ))}
            </ul>
          </div>
        ))}
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function CategoriesTab({ categories, onChanged }: { categories: Category[]; onChanged: () => void }) {
  const [busy, setBusy] = useState<number | null>(null);

  const toggle = async (category: Category) => {
    setBusy(category.id);
    try {
      await api(`/api/admin/categories/${category.id}`, {
        method: "PATCH",
        body: { isActive: category.is_active === 1 ? false : true },
      });
      toast(category.is_active === 1 ? "Kategoria wyłączona" : "Kategoria włączona");
      onChanged();
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : "Operacja nie powiodła się", "error");
    } finally {
      setBusy(null);
    }
  };

  const rename = async (category: Category, name: string) => {
    if (name.trim() === category.name) return;
    setBusy(category.id);
    try {
      await api(`/api/admin/categories/${category.id}`, { method: "PATCH", body: { name } });
      toast("Nazwa zmieniona");
      onChanged();
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : "Operacja nie powiodła się", "error");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="space-y-3">
      <p className="text-[11.5px] text-[var(--ub-text-dim)]">
        Kategorie definiują pola formularza dostępu. Wyłączenie kategorii ukrywa ją przy dodawaniu nowych dostępów —
        istniejące wpisy pozostają.
      </p>
      {categories.map((category) => (
        <div key={category.id} className={`ub-card p-3.5 ${category.is_active === 0 ? "opacity-60" : ""}`}>
          <div className="flex flex-wrap items-center gap-2">
            <input
              defaultValue={category.name}
              onBlur={(event) => void rename(category, event.target.value)}
              className="ub-input w-40 py-1 text-[12.5px]"
              aria-label={`Nazwa kategorii ${category.slug}`}
            />
            <span className="ub-mono text-[10.5px] text-[var(--ub-text-dim)]">{category.slug}</span>
            <span className="text-[11px] text-[var(--ub-text-dim)]">{category.fields.length} pól</span>
            <button
              type="button"
              onClick={() => void toggle(category)}
              disabled={busy === category.id}
              className="ub-btn ub-btn-ghost ml-auto px-2 py-1 text-[11px]"
            >
              {category.is_active === 1 ? "wyłącz" : "włącz"}
            </button>
          </div>
          {category.fields.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1">
              {category.fields.map((field) => (
                <span key={field.key} className={`ub-chip ${field.secret ? "ub-chip-warn" : ""}`}>
                  {field.label}
                  {field.secret && " 🔒"}
                  {field.required && <span className="text-[var(--ub-danger)]">*</span>}
                </span>
              ))}
            </div>
          )}
        </div>
      ))}
      <p className="text-[11px] text-[var(--ub-text-dim)]">
        Definicje pól (własne pola kategorii „Inne”) są przechowywane jako JSON w bazie — edycja wymaga bezpośredniego
        dostępu do serwera i jest logowana w audycie.
      </p>
    </div>
  );
}

/* ------------------------------------------------------------------ */

function KeysTab({ keys }: { keys: { version: number; created_at: number; retired_at: number | null }[] }) {
  return (
    <div className="space-y-3">
      <div className="ub-card p-4">
        <p className="ub-panel-title mb-2">Szyfrowanie kopertowe</p>
        <p className="text-[12px] leading-relaxed text-[var(--ub-text-muted)]">
          Sekrety są szyfrowane AES-256-GCM kluczem danych (DEK). DEK jest opakowany kluczem głównym (KEK) trzymanym
          poza bazą — w zmiennej <code className="ub-mono">USERBASE_KEK</code> lub pliku{" "}
          <code className="ub-mono">USERBASE_KEK_FILE</code>. Kopia bazy bez KEK jest bezużyteczna, a KEK bez bazy nic
          nie otwiera.
        </p>
        <p className="mt-2 text-[12px] text-[var(--ub-warn)]">
          Utrata KEK oznacza bezpowrotną utratę wszystkich sekretów. Przechowuj go w sejfie haseł.
        </p>
      </div>

      <div className="ub-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--ub-border)] text-left">
              <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Wersja DEK</th>
              <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Utworzony</th>
              <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Status</th>
            </tr>
          </thead>
          <tbody className="ub-divide">
            {keys.map((key) => (
              <tr key={key.version}>
                <td className="px-4 py-2 text-[12.5px] ub-mono">v{key.version}</td>
                <td className="px-4 py-2 text-[12px] text-[var(--ub-text-muted)]">{formatDate(key.created_at)}</td>
                <td className="px-4 py-2">
                  {key.retired_at ? <span className="ub-chip">wycofany</span> : <span className="ub-chip ub-chip-ok">aktywny</span>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <p className="text-[11px] text-[var(--ub-text-dim)]">
        Rotacja KEK: <code className="ub-mono">npm run key:rotate-kek</code> (w kontenerze). Rotacja DEK odbywa się
        przez CLI i przepakowuje sekrety partiami.
      </p>
    </div>
  );
}
