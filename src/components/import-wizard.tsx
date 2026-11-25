"use client";

/**
 * Kreator importu: 1) plik, 2) mapowanie kolumn, 3) podgląd z rozwiązywaniem jednostek,
 * 4) zapis. Plik trzymamy w pamięci i wysyłamy ponownie przy każdym kroku —
 * serwer nie przechowuje uploadów między żądaniami.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Link from "next/link";
import type { ImportPreview } from "@/lib/domain/types";
import { ApiError, api } from "@/lib/client";
import { toast } from "@/components/toast";

type ColumnKey = "firstName" | "lastName" | "fullName" | "position" | "orgUnit" | "email" | "phone" | "ignore";

const COLUMNS: { key: ColumnKey; label: string }[] = [
  { key: "firstName", label: "Imię" },
  { key: "lastName", label: "Nazwisko" },
  { key: "fullName", label: "Imię i nazwisko" },
  { key: "position", label: "Stanowisko / rola" },
  { key: "orgUnit", label: "Sklep / zakład / jednostka" },
  { key: "email", label: "E-mail" },
  { key: "phone", label: "Telefon" },
  { key: "ignore", label: "Pomiń kolumnę" },
];

type Unit = { id: number; type: string; name: string; number: string | null };

const STATUS_META: Record<string, { label: string; tone: string }> = {
  ok: { label: "nowy", tone: "ub-chip-ok" },
  duplicate: { label: "duplikat", tone: "ub-chip-warn" },
  warning: { label: "uwaga", tone: "ub-chip-warn" },
  error: { label: "błąd", tone: "ub-chip-danger" },
};

function csrfToken(): string {
  const match = document.cookie.match(/(?:^|;\s*)ub_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export function ImportWizard() {
  const [step, setStep] = useState<1 | 2 | 3 | 4>(1);
  const [file, setFile] = useState<File | null>(null);
  const [columns, setColumns] = useState<string[]>([]);
  const [mapping, setMapping] = useState<Record<string, ColumnKey>>({});
  const [suggested, setSuggested] = useState<Record<string, ColumnKey>>({});
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [units, setUnits] = useState<Unit[]>([]);
  const [resolution, setResolution] = useState<Record<string, string>>({});
  const [createMissingUnits, setCreateMissingUnits] = useState(false);
  const [onlyValid, setOnlyValid] = useState(true);
  const [busy, setBusy] = useState(false);
  // Kontrakt serwera: błędy to obiekty { rowNumber, message }, nie stringi.
  // Renderowanie obiektu jako dziecka Reacta wywala całą stronę na 500 —
  // import się wtedy udaje, a operator widzi tylko „strona nie działa".
  const [result, setResult] = useState<{ created: number; skipped: number; errors: { rowNumber: number; message: string }[] } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    api<{ units: Unit[] }>("/api/admin/org-units")
      .then((data) => setUnits(data.units))
      .catch(() => undefined);
  }, []);

  const send = async (endpoint: "preview" | "commit") => {
    if (!file) return;
    setError(null);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", file);
      form.set("mapping", JSON.stringify(mapping));
      if (Object.keys(resolution).length > 0) form.set("unitResolution", JSON.stringify(resolution));
      form.set("createMissingUnits", createMissingUnits ? "1" : "0");
      form.set("onlyValid", onlyValid ? "1" : "0");

      const response = await fetch(`/api/import/${endpoint}`, {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken() },
        body: form,
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new ApiError(response.status, String(data.error ?? "Błąd importu"), String(data.code ?? "error"));

      if (endpoint === "preview") {
        const payload = data.preview as ImportPreview;
        setPreview(payload);
        setStep(3);
      } else {
        setResult(data.result as { created: number; skipped: number; errors: { rowNumber: number; message: string }[] });
        setStep(4);
        toast("Import zakończony");
      }
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Nie udało się przetworzyć pliku");
    } finally {
      setBusy(false);
    }
  };

  const upload = async (selected: File) => {
    if (!selected.name.toLowerCase().endsWith(".xlsx")) {
      setError("Dozwolone są wyłącznie pliki .xlsx (Excel 2007+).");
      return;
    }
    if (selected.size > 10 * 1024 * 1024) {
      setError("Plik jest za duży — limit to 10 MB.");
      return;
    }
    setError(null);
    setFile(selected);
    setBusy(true);
    try {
      const form = new FormData();
      form.set("file", selected);
      const response = await fetch("/api/import/preview", {
        method: "POST",
        headers: { "X-CSRF-Token": csrfToken() },
        body: form,
      });
      const data = (await response.json()) as Record<string, unknown>;
      if (!response.ok) throw new ApiError(response.status, String(data.error ?? "Nie udało się odczytać pliku"), "error");

      const sheet = data.sheet as { columns: string[] };
      const payload = data.preview as ImportPreview;
      const suggestion = (payload.suggestedMapping ?? {}) as Record<string, ColumnKey>;
      setColumns(sheet.columns);
      setSuggested(suggestion);
      setMapping(suggestion);
      setStep(2);
    } catch (reason) {
      setFile(null);
      setError(reason instanceof ApiError ? reason.message : "Nie udało się odczytać pliku");
    } finally {
      setBusy(false);
    }
  };

  const unknownUnits = preview?.unknownUnits ?? [];
  const unitOptions = useMemo(
    () =>
      [...units].sort(
        (a, b) =>
          ({ zaklad: 0, biuro: 1, region: 2, sklep: 3 }[a.type] ?? 9) -
            ({ zaklad: 0, biuro: 1, region: 2, sklep: 3 }[b.type] ?? 9) || a.name.localeCompare(b.name, "pl"),
      ),
    [units],
  );

  /**
   * Decyzje o jednostkach zmieniają to, ile wierszy wejdzie — licznik i blokada
   * przycisku muszą pochodzić z serwera, nie z lokalnej arytmetyki. Dlatego każda
   * zmiana przypisania odświeża podgląd (plik i tak trzymamy w pamięci).
   */
  const refreshPreview = useCallback(
    async (nextResolution: Record<string, string>, nextCreateMissing: boolean) => {
      if (!file) return;
      setError(null);
      setBusy(true);
      try {
        const form = new FormData();
        form.set("file", file);
        form.set("mapping", JSON.stringify(mapping));
        if (Object.keys(nextResolution).length > 0) form.set("unitResolution", JSON.stringify(nextResolution));
        form.set("createMissingUnits", nextCreateMissing ? "1" : "0");
        const response = await fetch("/api/import/preview", {
          method: "POST",
          headers: { "X-CSRF-Token": csrfToken() },
          body: form,
        });
        const data = (await response.json()) as Record<string, unknown>;
        if (!response.ok) throw new ApiError(response.status, String(data.error ?? "Nie udało się odświeżyć podglądu"), "error");
        setPreview(data.preview as ImportPreview);
      } catch (reason) {
        setError(reason instanceof ApiError ? reason.message : "Nie udało się odświeżyć podglądu");
      } finally {
        setBusy(false);
      }
    },
    [file, mapping],
  );

  const missingRequired = !mapping || (!Object.values(mapping).includes("firstName") && !Object.values(mapping).includes("fullName")) ||
    (!Object.values(mapping).includes("lastName") && !Object.values(mapping).includes("fullName"));

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold tracking-tight">Import z Excela</h1>
        <p className="mt-0.5 text-[12.5px] text-[var(--ub-text-dim)]">
          Wgraj plik .xlsx — kolumny dopasujesz w następnym kroku. Import dodaje osoby, nie nadpisuje istniejących.
        </p>
      </header>

      <ol className="mb-6 flex flex-wrap items-center gap-2 text-[11.5px]">
        {(["Plik", "Kolumny", "Podgląd", "Wynik"] as const).map((label, index) => {
          const number = index + 1;
          const active = step === number;
          const done = step > number;
          return (
            <li key={label} className="flex items-center gap-2">
              <span
                className={`flex h-5 w-5 items-center justify-center rounded-full text-[10px] font-semibold ${
                  active
                    ? "bg-[var(--ub-accent)] text-[#17130a]"
                    : done
                      ? "bg-[var(--ub-ok-soft)] text-[var(--ub-ok)]"
                      : "border border-[var(--ub-border-strong)] text-[var(--ub-text-dim)]"
                }`}
              >
                {done ? "✓" : number}
              </span>
              <span className={active ? "font-medium text-[var(--ub-text)]" : "text-[var(--ub-text-dim)]"}>{label}</span>
              {index < 3 && <span className="mx-1 h-px w-6 bg-[var(--ub-border-strong)]" />}
            </li>
          );
        })}
      </ol>

      {error && (
        <div className="mb-4 rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3.5 py-2.5 text-[12.5px] text-[var(--ub-danger)]">
          {error}
        </div>
      )}

      {step === 1 && (
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            const dropped = event.dataTransfer.files[0];
            if (dropped) void upload(dropped);
          }}
          className={`ub-card flex flex-col items-center justify-center px-6 py-16 text-center transition-colors ${
            dragging ? "border-[var(--ub-accent)] bg-[var(--ub-accent-soft)]" : ""
          }`}
        >
          <input
            ref={inputRef}
            type="file"
            accept=".xlsx"
            className="hidden"
            onChange={(event) => {
              const selected = event.target.files?.[0];
              if (selected) void upload(selected);
            }}
          />
          <div className="mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ub-bg-hover)] text-[var(--ub-text-muted)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" aria-hidden>
              <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
              <path d="M17 8l-5-5-5 5M12 3v12" />
            </svg>
          </div>
          <p className="text-[14px] font-medium">{busy ? "Wczytywanie pliku…" : "Przeciągnij plik .xlsx albo wybierz z dysku"}</p>
          <p className="mt-1 text-[12px] text-[var(--ub-text-dim)]">Pierwszy wiersz to nagłówki. Limit 10 MB, do 5000 wierszy.</p>
          <button type="button" onClick={() => inputRef.current?.click()} disabled={busy} className="ub-btn ub-btn-primary mt-4">
            Wybierz plik
          </button>
        </div>
      )}

      {step === 2 && (
        <div className="ub-card overflow-hidden">
          <div className="border-b border-[var(--ub-border)] px-4 py-3">
            <h2 className="text-[14px] font-semibold">Dopasuj kolumny</h2>
            <p className="text-[11.5px] text-[var(--ub-text-dim)]">
              Plik: {file?.name}. Sugestie zaznaczone automatycznie — sprawdź je.
            </p>
          </div>
          <div className="ub-divide max-h-[28rem] overflow-y-auto">
            {columns.map((column) => (
              <div key={column} className="flex items-center gap-3 px-4 py-2">
                <span className="min-w-0 flex-1 truncate text-[12.5px]">{column}</span>
                <select
                  value={mapping[column] ?? "ignore"}
                  onChange={(event) => setMapping((current) => ({ ...current, [column]: event.target.value as ColumnKey }))}
                  className={`ub-input w-52 ${suggested[column] && suggested[column] !== "ignore" ? "border-[var(--ub-accent)]" : ""}`}
                >
                  {COLUMNS.map((option) => (
                    <option key={option.key} value={option.key}>
                      {option.label}
                    </option>
                  ))}
                </select>
              </div>
            ))}
          </div>
          <div className="flex items-center justify-between gap-2 border-t border-[var(--ub-border)] px-4 py-3">
            <button type="button" onClick={() => { setStep(1); setFile(null); setPreview(null); }} className="ub-btn ub-btn-secondary">
              Wstecz
            </button>
            <div className="flex items-center gap-3">
              {missingRequired && (
                <span className="text-[11.5px] text-[var(--ub-warn)]">Wskaż imię i nazwisko (albo kolumnę „Imię i nazwisko”).</span>
              )}
              <button type="button" onClick={() => void send("preview")} disabled={busy || missingRequired} className="ub-btn ub-btn-primary">
                {busy ? "Analizowanie…" : "Pokaż podgląd"}
              </button>
            </div>
          </div>
        </div>
      )}

      {step === 3 && preview && (
        <div className="space-y-4">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-5">
            {[
              { label: "Wiersze", value: preview.summary.total, tone: "" },
              { label: "Nowe", value: preview.summary.ok, tone: "text-[var(--ub-ok)]" },
              { label: "Duplikaty", value: preview.summary.duplicate, tone: "text-[var(--ub-warn)]" },
              { label: "Uwagi", value: preview.summary.warning, tone: "text-[var(--ub-warn)]" },
              { label: "Błędy", value: preview.summary.error, tone: "text-[var(--ub-danger)]" },
            ].map((stat) => (
              <div key={stat.label} className="ub-card px-3 py-2.5">
                <p className="text-[10.5px] uppercase tracking-wide text-[var(--ub-text-dim)]">{stat.label}</p>
                <p className={`text-[18px] font-semibold ${stat.tone}`}>{stat.value}</p>
              </div>
            ))}
          </div>

          {unknownUnits.length > 0 && (
            <div className="ub-card p-4">
              <h3 className="text-[13px] font-semibold text-[var(--ub-warn)]">
                Nierozpoznane jednostki ({unknownUnits.length})
              </h3>
              <p className="mb-3 text-[11.5px] text-[var(--ub-text-dim)]">
                Przypisz je do istniejących albo pozwól utworzyć nowe sklepy.
              </p>
              <div className="space-y-2">
                {unknownUnits.map((name) => (
                  <div key={name} className="flex flex-wrap items-center gap-2">
                    <span className="min-w-[140px] flex-1 truncate text-[12.5px]">{name}</span>
                    <select
                      value={resolution[name] ?? ""}
                      onChange={(event) => {
                        const nextResolution = { ...resolution, [name]: event.target.value };
                        setResolution(nextResolution);
                        void refreshPreview(nextResolution, createMissingUnits);
                      }}
                      className="ub-input w-56"
                    >
                      <option value="">— utwórz jako nowy sklep —</option>
                      {unitOptions.map((unit) => (
                        <option key={unit.id} value={String(unit.id)}>
                          {unit.name}
                        </option>
                      ))}
                    </select>
                  </div>
                ))}
              </div>
              <label className="mt-3 flex items-center gap-2 text-[12px] text-[var(--ub-text-muted)]">
                <input
                  type="checkbox"
                  checked={createMissingUnits}
                  onChange={(event) => {
                    const next = event.target.checked;
                    setCreateMissingUnits(next);
                    void refreshPreview(resolution, next);
                  }}
                  className="h-3.5 w-3.5 accent-[var(--ub-accent)]"
                />
                Utwórz brakujące jednostki jako sklepy
              </label>
            </div>
          )}

          <div className="ub-card overflow-hidden">
            <div className="border-b border-[var(--ub-border)] px-4 py-2.5">
              <h3 className="text-[13px] font-semibold">Podgląd wierszy</h3>
            </div>
            <div className="max-h-80 overflow-auto">
              <table className="w-full">
                <thead className="sticky top-0 bg-[var(--ub-bg-panel)]">
                  <tr className="border-b border-[var(--ub-border)] text-left">
                    <th className="px-3 py-2 text-[10.5px] uppercase tracking-wide text-[var(--ub-text-dim)]">Wiersz</th>
                    <th className="px-3 py-2 text-[10.5px] uppercase tracking-wide text-[var(--ub-text-dim)]">Osoba</th>
                    <th className="px-3 py-2 text-[10.5px] uppercase tracking-wide text-[var(--ub-text-dim)]">Jednostka</th>
                    <th className="px-3 py-2 text-[10.5px] uppercase tracking-wide text-[var(--ub-text-dim)]">Status</th>
                  </tr>
                </thead>
                <tbody className="ub-divide">
                  {preview.rows.map((row) => (
                    <tr key={row.rowNumber}>
                      <td className="px-3 py-1.5 text-[11px] text-[var(--ub-text-dim)]">{row.rowNumber}</td>
                      <td className="px-3 py-1.5 text-[12px]">
                        {row.normalized ? `${row.normalized.firstName} ${row.normalized.lastName}` : <span className="text-[var(--ub-text-dim)]">—</span>}
                      </td>
                      <td className="px-3 py-1.5 text-[12px] text-[var(--ub-text-muted)]">
                        {row.normalized?.orgUnitName ?? "—"}
                      </td>
                      <td className="px-3 py-1.5">
                        <span className={`ub-chip ${STATUS_META[row.status]?.tone ?? ""}`}>
                          {STATUS_META[row.status]?.label ?? row.status}
                        </span>
                        {row.messages.length > 0 && (
                          <span className="ml-1.5 text-[11px] text-[var(--ub-text-dim)]">{row.messages.join("; ")}</span>
                        )}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>

          <label className="flex items-center gap-2 text-[12px] text-[var(--ub-text-muted)]">
            <input
              type="checkbox"
              checked={onlyValid}
              onChange={(event) => setOnlyValid(event.target.checked)}
              className="h-3.5 w-3.5 accent-[var(--ub-accent)]"
            />
            Importuj tylko wiersze bez błędów
          </label>

          <div className="flex gap-2">
            <button type="button" onClick={() => setStep(2)} className="ub-btn ub-btn-secondary">
              Wstecz
            </button>
            <button type="button" onClick={() => void send("commit")} disabled={busy || (onlyValid && preview.importable === 0)} className="ub-btn ub-btn-primary">
              {busy ? "Zapisywanie…" : `Zaimportuj ${onlyValid ? preview.importable : preview.summary.total} osób`}
            </button>
          </div>
        </div>
      )}

      {step === 4 && result && (
        <div className="ub-card p-6 text-center">
          <div className="mx-auto mb-3 flex h-12 w-12 items-center justify-center rounded-full bg-[var(--ub-ok-soft)] text-[var(--ub-ok)]">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <path d="M20 6 9 17l-5-5" />
            </svg>
          </div>
          <h2 className="text-[16px] font-semibold">Import zakończony</h2>
          <p className="mt-1 text-[12.5px] text-[var(--ub-text-muted)]">
            Dodano {result.created} {result.created === 1 ? "osobę" : "osób"}, pominięto {result.skipped}.
          </p>
          {result.errors.length > 0 && (
            <ul className="mx-auto mt-3 max-w-md space-y-1 text-left text-[11.5px] text-[var(--ub-danger)]">
              {result.errors.map((entry) => (
                <li key={entry.rowNumber}>• Wiersz {entry.rowNumber}: {entry.message}</li>
              ))}
            </ul>
          )}
          <div className="mt-4 flex justify-center gap-2">
            <Link href="/" className="ub-btn ub-btn-primary">
              Przejdź do listy
            </Link>
            <button
              type="button"
              onClick={() => {
                setStep(1);
                setFile(null);
                setPreview(null);
                setResult(null);
                setResolution({});
              }}
              className="ub-btn ub-btn-secondary"
            >
              Importuj kolejny plik
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
