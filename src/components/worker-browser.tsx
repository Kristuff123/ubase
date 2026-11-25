"use client";

/**
 * Lista pracowników: wyszukiwarka, filtr statusu i kategorii, quick-add (skrót `n`).
 * Dodawanie nowego pracownika ma być szybkie — formularz wsuwa się z prawej,
 * Enter zapisuje i przechodzi do kartoteki.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useRef, useState } from "react";
import type { OrgUnit, WorkerListItem } from "@/lib/domain/types";
import { formatDateTime } from "@/lib/utils";

type Category = { slug: string; name: string; icon: string | null };
type StatusFilter = "aktywny" | "archiwum" | "wszyscy";

export function WorkerBrowser({ categories, role }: { categories: Category[]; role: string; currentUser: string }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<StatusFilter>("aktywny");
  const [category, setCategory] = useState<string>("");
  const [items, setItems] = useState<WorkerListItem[]>([]);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [quickOpen, setQuickOpen] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const canEdit = role === "admin" || role === "operator";

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ status, limit: "100" });
      if (query.trim()) params.set("q", query.trim());
      if (category) params.set("category", category);
      const response = await fetch(`/api/workers?${params.toString()}`);
      if (!response.ok) return;
      const data = (await response.json()) as { items: WorkerListItem[]; total: number };
      setItems(data.items);
      setTotal(data.total);
    } finally {
      setLoading(false);
    }
  }, [query, status, category]);

  useEffect(() => {
    const timer = setTimeout(load, query ? 150 : 0);
    return () => clearTimeout(timer);
  }, [load, query]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing = target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.tagName === "SELECT";
      if (event.key === "n" && !typing && canEdit) {
        event.preventDefault();
        setQuickOpen(true);
      }
      if (event.key === "Escape") setQuickOpen(false);
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [canEdit]);

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-6 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Pracownicy</h1>
          <p className="mt-0.5 text-[12.5px] text-[var(--ub-text-dim)]">
            {loading ? "Wczytywanie…" : `${total} ${total === 1 ? "osoba" : "osób"} w tym widoku`}
          </p>
        </div>
        {canEdit && (
          <button type="button" onClick={() => setQuickOpen(true)} className="ub-btn ub-btn-primary">
            <span className="text-[15px] leading-none">+</span> Nowy pracownik
            <kbd className="ml-1 rounded bg-black/15 px-1 text-[10px] font-normal">n</kbd>
          </button>
        )}
      </header>

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <div className="relative min-w-[220px] flex-1">
          <svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" className="absolute left-3 top-1/2 -translate-y-1/2 text-[var(--ub-text-dim)]" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={searchRef}
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Szukaj: nazwisko, login, numer chipa, sklep…"
            className="ub-input pl-9"
            aria-label="Szukaj pracowników"
          />
          {query && (
            <button
              type="button"
              onClick={() => setQuery("")}
              className="absolute right-2 top-1/2 -translate-y-1/2 rounded p-1 text-[var(--ub-text-dim)] hover:text-[var(--ub-text)]"
              aria-label="Wyczyść"
            >
              ✕
            </button>
          )}
        </div>

        <div className="flex rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] bg-[var(--ub-bg-input)] p-0.5">
          {(
            [
              ["aktywny", "Aktywni"],
              ["archiwum", "Archiwum"],
              ["wszyscy", "Wszyscy"],
            ] as [StatusFilter, string][]
          ).map(([value, label]) => (
            <button
              key={value}
              type="button"
              onClick={() => setStatus(value)}
              className={`rounded-[4px] px-3 py-1.5 text-[12px] transition-colors ${
                status === value
                  ? "bg-[var(--ub-bg-hover)] font-medium text-[var(--ub-text)]"
                  : "text-[var(--ub-text-dim)] hover:text-[var(--ub-text-muted)]"
              }`}
            >
              {label}
            </button>
          ))}
        </div>
      </div>

      <div className="mb-4 flex flex-wrap gap-1.5">
        <button
          type="button"
          onClick={() => setCategory("")}
          className={`ub-chip transition-colors ${!category ? "ub-chip-accent" : "hover:text-[var(--ub-text)]"}`}
        >
          wszystkie
        </button>
        {categories.map((item) => (
          <button
            key={item.slug}
            type="button"
            onClick={() => setCategory(category === item.slug ? "" : item.slug)}
            className={`ub-chip transition-colors ${category === item.slug ? "ub-chip-accent" : "hover:text-[var(--ub-text)]"}`}
          >
            {item.name}
          </button>
        ))}
      </div>

      <div className="ub-card overflow-x-auto">
        {items.length === 0 && !loading ? (
          <div className="px-6 py-16 text-center">
            <div className="mx-auto mb-3 flex h-11 w-11 items-center justify-center rounded-full bg-[var(--ub-bg-hover)] text-[var(--ub-text-dim)]">
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
                <circle cx="11" cy="11" r="8" />
                <path d="m21 21-4.3-4.3" />
              </svg>
            </div>
            <p className="text-[13.5px] font-medium">
              {query ? "Brak wyników" : status === "archiwum" ? "Archiwum jest puste" : "Brak pracowników"}
            </p>
            <p className="mt-1 text-[12px] text-[var(--ub-text-dim)]">
              {query ? "Spróbuj innej frazy albo zmień filtr." : canEdit ? "Dodaj pierwszą osobę skrótem „n”." : "Poproś administratora o dodanie osób."}
            </p>
          </div>
        ) : (
          <table className="w-full table-fixed sm:table-auto">
            <thead>
              <tr className="border-b border-[var(--ub-border)] text-left">
                <th className="px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Osoba</th>
                <th className="hidden px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] sm:table-cell">Jednostka</th>
                <th className="w-[42%] px-4 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] sm:w-auto">Dostępy</th>
                <th className="hidden px-4 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] md:table-cell">Zmiana</th>
              </tr>
            </thead>
            <tbody className="ub-divide">
              {items.map((item) => (
                <tr key={item.id} className="ub-row-hover group">
                  <td className="px-4 py-2.5">
                    <Link href={`/pracownicy/${item.id}`} className="flex items-center gap-3">
                      <span
                        className={`flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-[11px] font-semibold ${
                          item.status === "aktywny"
                            ? "bg-[var(--ub-accent-soft)] text-[var(--ub-accent-text)]"
                            : "bg-[var(--ub-bg-hover)] text-[var(--ub-text-dim)]"
                        }`}
                      >
                        {item.firstName[0]}
                        {item.lastName[0]}
                      </span>
                      <span className="min-w-0 flex-1">
                        <span className="flex items-center gap-2">
                          <span title={`${item.lastName} ${item.firstName}`} className="min-w-0 truncate text-[13.5px] font-medium group-hover:text-[var(--ub-accent-text)]">
                            {item.lastName} {item.firstName}
                          </span>
                          {item.status === "zarchiwizowany" && <span className="ub-chip">archiwum</span>}
                        </span>
                        <span className="block truncate text-[11.5px] text-[var(--ub-text-dim)]">
                          {item.position ?? "—"}
                        </span>
                      </span>
                    </Link>
                  </td>
                  <td className="hidden px-4 py-2.5 text-[12.5px] text-[var(--ub-text-muted)] sm:table-cell">
                    {item.orgUnitName ?? "—"}
                  </td>
                  <td className="px-4 py-2.5">
                    <div className="flex flex-wrap gap-1">
                      {item.categories.length === 0 && <span className="text-[11.5px] text-[var(--ub-text-dim)]">brak</span>}
                      {item.categories.map((entry) => (
                        <span key={entry.slug} className="ub-chip">
                          {entry.name}
                          {entry.count > 1 && <span className="text-[var(--ub-text-dim)]">×{entry.count}</span>}
                        </span>
                      ))}
                    </div>
                  </td>
                  <td className="hidden px-4 py-2.5 text-right text-[11.5px] text-[var(--ub-text-dim)] md:table-cell">
                    {formatDateTime(item.updatedAt)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </div>

      {quickOpen && (
        <QuickAddPanel
          onClose={() => setQuickOpen(false)}
          onCreated={(id) => {
            setQuickOpen(false);
            router.push(`/pracownicy/${id}`);
          }}
        />
      )}
    </div>
  );
}

function QuickAddPanel({ onClose, onCreated }: { onClose: () => void; onCreated: (id: number) => void }) {
  const [units, setUnits] = useState<OrgUnit[]>([]);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [position, setPosition] = useState("");
  const [unitId, setUnitId] = useState<string>("");
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [duplicate, setDuplicate] = useState<{ id: number; firstName: string; lastName: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const firstRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    firstRef.current?.focus();
    fetch("/api/catalog")
      .then((response) => response.json())
      .then((data: { units: OrgUnit[] }) => setUnits(data.units))
      .catch(() => undefined);
  }, []);

  const unitsSorted = [...units].sort((a, b) => {
    const order = { zaklad: 0, biuro: 1, region: 2, sklep: 3 };
    return (order[a.type] ?? 9) - (order[b.type] ?? 9) || a.name.localeCompare(b.name, "pl");
  });

  const save = async (force = false) => {
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/workers", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-CSRF-Token": document.cookie.match(/(?:^|;\s*)ub_csrf=([^;]+)/)?.[1] ?? "",
        },
        body: JSON.stringify({
          firstName,
          lastName,
          position,
          orgUnitId: unitId ? Number(unitId) : null,
          email,
          force,
        }),
      });
      const data = (await response.json()) as {
        id?: number;
        error?: string;
        code?: string;
        duplicate?: { id: number; firstName: string; lastName: string };
      };
      if (response.status === 409 && data.duplicate) {
        setDuplicate(data.duplicate);
        return;
      }
      if (!response.ok || !data.id) {
        setError(data.error ?? "Nie udało się zapisać");
        return;
      }
      onCreated(data.id);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-40 bg-black/50 backdrop-blur-[2px]" onClick={onClose} role="presentation">
      <div
        className="ub-slide-in absolute right-0 top-0 h-full w-full max-w-md border-l border-[var(--ub-border)] bg-[var(--ub-bg-elevated)] p-6 shadow-[var(--ub-shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Nowy pracownik"
      >
        <div className="mb-6 flex items-start justify-between">
          <div>
            <h2 className="text-[16px] font-semibold">Nowy pracownik</h2>
            <p className="text-[12px] text-[var(--ub-text-dim)]">Enter zapisuje — dostępy dodasz od razu na kartotece.</p>
          </div>
          <button type="button" onClick={onClose} className="ub-btn ub-btn-ghost px-2" aria-label="Zamknij">
            ✕
          </button>
        </div>

        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
          className="space-y-3.5"
        >
          <div className="grid grid-cols-2 gap-3">
            <div>
              <label htmlFor="fn" className="ub-label">
                Imię <span className="text-[var(--ub-danger)]">*</span>
              </label>
              <input ref={firstRef} id="fn" value={firstName} onChange={(e) => setFirstName(e.target.value)} required className="ub-input" />
            </div>
            <div>
              <label htmlFor="ln" className="ub-label">
                Nazwisko <span className="text-[var(--ub-danger)]">*</span>
              </label>
              <input id="ln" value={lastName} onChange={(e) => setLastName(e.target.value)} required className="ub-input" />
            </div>
          </div>

          <div>
            <label htmlFor="unit" className="ub-label">
              Sklep / zakład / biuro
            </label>
            <select id="unit" value={unitId} onChange={(e) => setUnitId(e.target.value)} className="ub-input">
              <option value="">— nie przypisano —</option>
              {unitsSorted.map((unit) => (
                <option key={unit.id} value={unit.id}>
                  {unit.type === "zaklad" ? "🏭 " : unit.type === "region" ? "🗺 " : unit.type === "biuro" ? "🏢 " : "🏬 "}
                  {unit.name}
                </option>
              ))}
            </select>
          </div>

          <div>
            <label htmlFor="pos" className="ub-label">
              Stanowisko
            </label>
            <input id="pos" value={position} onChange={(e) => setPosition(e.target.value)} className="ub-input" placeholder="np. kierownik zmiany" />
          </div>

          <div>
            <label htmlFor="mail" className="ub-label">
              Służbowy e-mail (opcjonalnie)
            </label>
            <input id="mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="ub-input" placeholder="jan.kowalski@firma.pl" />
          </div>

          {error && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
              {error}
            </div>
          )}

          {duplicate && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(245,165,36,0.35)] bg-[var(--ub-warn-soft)] px-3 py-2.5 text-[12px] text-[var(--ub-warn)]">
              <p className="font-medium">Taka osoba już istnieje w tej jednostce.</p>
              <div className="mt-2 flex gap-2">
                <button type="button" onClick={() => onCreated(duplicate.id)} className="ub-btn ub-btn-secondary px-2 py-1 text-[11.5px]">
                  Otwórz istniejącą
                </button>
                <button type="button" onClick={() => void save(true)} className="ub-btn ub-btn-secondary px-2 py-1 text-[11.5px]">
                  Dodaj mimo to
                </button>
              </div>
            </div>
          )}

          <div className="flex gap-2 pt-2">
            <button type="submit" disabled={busy} className="ub-btn ub-btn-primary flex-1 py-2.5">
              {busy ? "Zapisywanie…" : "Zapisz i dodaj dostępy"}
            </button>
            <button type="button" onClick={onClose} className="ub-btn ub-btn-secondary">
              Anuluj
            </button>
          </div>
        </form>
      </div>
    </div>
  );
}
