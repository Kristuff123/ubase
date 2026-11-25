"use client";

/**
 * Widok audytu: lista zdarzeń z filtrami, weryfikacja integralności łańcucha
 * (SHA-256 prev_hash + payload) i eksport CSV.
 */
import { useCallback, useEffect, useState } from "react";
import type { AuditEventView } from "@/lib/domain/types";
import { ApiError, api } from "@/lib/client";
import { formatDateTime } from "@/lib/utils";
import { toast } from "@/components/toast";
import { ACTION_LABELS } from "@/lib/audit/labels";

type AuditResponse = { events: AuditEventView[]; actions: { action: string; count: number }[] };

function actionLabel(action: string): string {
  // Etykiety są kompletne dla każdej akcji z unii `AuditAction` (pilnuje tego
  // tests/audit/labels.test.ts). Fallback zostaje dla starych wpisów w bazie.
  return (ACTION_LABELS as Record<string, string>)[action] ?? action;
}

function actionTone(action: string): string {
  if (action.includes("failed") || action.includes("locked")) return "ub-chip-danger";
  if (action.startsWith("secret.")) return "ub-chip-warn";
  if (action === "audit.verified") return "ub-chip-ok";
  return "";
}

export function AuditView() {
  const [events, setEvents] = useState<AuditEventView[]>([]);
  const [actions, setActions] = useState<{ action: string; count: number }[]>([]);
  const [actionFilter, setActionFilter] = useState("");
  const [query, setQuery] = useState("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<number | null>(null);
  const [verify, setVerify] = useState<{ valid: boolean; checked: number; brokenAt: number | null } | null>(null);
  const [verifying, setVerifying] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const params = new URLSearchParams({ limit: "200" });
      if (actionFilter) params.set("action", actionFilter);
      if (from) params.set("from", new Date(`${from}T00:00:00`).toISOString());
      if (to) params.set("to", new Date(`${to}T23:59:59`).toISOString());
      const data = await api<AuditResponse>(`/api/audit?${params.toString()}`);
      setEvents(data.events);
      setActions(data.actions);
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Nie udało się wczytać audytu", "error");
    } finally {
      setLoading(false);
    }
  }, [actionFilter, from, to]);

  useEffect(() => {
    void load();
  }, [load]);

  const filtered = query.trim()
    ? events.filter((event) =>
        `${event.summary} ${event.actorName ?? ""} ${actionLabel(event.action)}`
          .toLowerCase()
          .includes(query.trim().toLowerCase()),
      )
    : events;

  const runVerify = async () => {
    setVerifying(true);
    try {
      const result = await api<{ valid: boolean; checked: number; brokenAt: number | null }>("/api/audit/verify");
      setVerify(result);
      if (result.valid) toast(`Łańcuch poprawny — sprawdzono ${result.checked} wpisów`);
      else toast(`Łańcuch USZKODZONY na wpisie ${result.brokenAt}`, "error");
      void load();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Weryfikacja nie powiodła się", "error");
    } finally {
      setVerifying(false);
    }
  };

  return (
    <div className="mx-auto max-w-6xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-5 flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="text-[20px] font-semibold tracking-tight">Audyt</h1>
          <p className="mt-0.5 text-[12.5px] text-[var(--ub-text-dim)]">
            Każde zdarzenie ma hash liczony z poprzedniego wpisu — zmiana historii jest wykrywalna.
          </p>
        </div>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={runVerify} disabled={verifying} className="ub-btn ub-btn-secondary">
            {verifying ? "Weryfikacja…" : "Sprawdź integralność"}
          </button>
          <a href="/api/audit/export" className="ub-btn ub-btn-primary">
            Eksport CSV
          </a>
        </div>
      </header>

      {verify && (
        <div
          className={`mb-4 rounded-[var(--ub-radius)] border px-4 py-2.5 text-[12.5px] ${
            verify.valid
              ? "border-[rgba(62,207,142,0.3)] bg-[var(--ub-ok-soft)] text-[var(--ub-ok)]"
              : "border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] text-[var(--ub-danger)]"
          }`}
        >
          {verify.valid
            ? `Łańcuch poprawny — ${verify.checked} wpisów, brak luk i podmian.`
            : `Wykryto uszkodzenie łańcucha na wpisie #${verify.brokenAt}. Zabezpiecz kopię bazy i przeanalizuj dostęp do serwera.`}
        </div>
      )}

      <div className="mb-4 flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Filtruj po treści, osobie…"
          className="ub-input min-w-[200px] flex-1"
          aria-label="Filtruj zdarzenia"
        />
        <select value={actionFilter} onChange={(event) => setActionFilter(event.target.value)} className="ub-input w-auto">
          <option value="">Wszystkie akcje ({actions.reduce((sum, item) => sum + item.count, 0)})</option>
          {actions.map((item) => (
            <option key={item.action} value={item.action}>
              {actionLabel(item.action)} ({item.count})
            </option>
          ))}
        </select>
        <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--ub-text-dim)]">
          Od
          <input type="date" value={from} onChange={(event) => setFrom(event.target.value)} className="ub-input w-auto" aria-label="Od" />
        </label>
        <label className="flex items-center gap-1.5 text-[11px] font-medium text-[var(--ub-text-dim)]">
          Do
          <input type="date" value={to} onChange={(event) => setTo(event.target.value)} className="ub-input w-auto" aria-label="Do" />
        </label>
      </div>

      <div className="ub-card overflow-hidden">
        <table className="w-full">
          <thead>
            <tr className="border-b border-[var(--ub-border)] text-left">
              <th className="w-16 px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">#</th>
              <th className="px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Czas</th>
              <th className="hidden px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] sm:table-cell">Osoba</th>
              <th className="px-3 py-2.5 text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)]">Zdarzenie</th>
              <th className="hidden px-3 py-2.5 text-right text-[10.5px] font-semibold uppercase tracking-wider text-[var(--ub-text-dim)] md:table-cell">Hash</th>
            </tr>
          </thead>
          <tbody className="ub-divide">
            {loading && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[12.5px] text-[var(--ub-text-dim)]">
                  Wczytywanie…
                </td>
              </tr>
            )}
            {!loading && filtered.length === 0 && (
              <tr>
                <td colSpan={5} className="px-4 py-10 text-center text-[12.5px] text-[var(--ub-text-dim)]">
                  Brak zdarzeń dla tych filtrów.
                </td>
              </tr>
            )}
            {filtered.map((event) => (
              <FragmentRow key={event.seq} event={event} expanded={expanded === event.seq} onToggle={() => setExpanded(expanded === event.seq ? null : event.seq)} />
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-[11px] text-[var(--ub-text-dim)]">
        Pokazano {filtered.length} z {events.length} wczytanych zdarzeń (limit 200 na stronę).
      </p>
    </div>
  );
}

function FragmentRow({
  event,
  expanded,
  onToggle,
}: {
  event: AuditEventView;
  expanded: boolean;
  onToggle: () => void;
}) {
  return (
    <>
      <tr className="ub-row-hover cursor-pointer" onClick={onToggle}>
        <td className="px-3 py-2 text-[11px] text-[var(--ub-text-dim)] ub-mono">{event.seq}</td>
        <td className="whitespace-nowrap px-3 py-2 text-[11.5px] text-[var(--ub-text-muted)]">{formatDateTime(event.at)}</td>
        <td className="hidden px-3 py-2 text-[12px] sm:table-cell">
          {event.actorName ?? <span className="text-[var(--ub-text-dim)]">system</span>}
          {event.actorIp && <span className="ml-1.5 text-[10.5px] text-[var(--ub-text-dim)]">{event.actorIp}</span>}
        </td>
        <td className="px-3 py-2">
          <div className="flex flex-wrap items-center gap-1.5">
            <span className={`ub-chip ${actionTone(event.action)}`}>{actionLabel(event.action)}</span>
            <span className="text-[12px] text-[var(--ub-text-muted)]">{event.summary}</span>
          </div>
        </td>
        <td className="hidden px-3 py-2 text-right md:table-cell">
          <code className="ub-mono text-[10px] text-[var(--ub-text-dim)]">{event.entryHash.slice(0, 10)}…</code>
        </td>
      </tr>
      {expanded && (
        <tr className="bg-[var(--ub-bg-input)]">
          <td colSpan={5} className="px-3 py-3">
            <dl className="grid gap-2 text-[11.5px] sm:grid-cols-2">
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">Encja</dt>
                <dd className="ub-mono">
                  {event.entityType ?? "—"}
                  {event.entityId !== null ? ` #${event.entityId}` : ""}
                </dd>
              </div>
              <div>
                <dt className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">Akcja techniczna</dt>
                <dd className="ub-mono">{event.action}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">Hash wpisu</dt>
                <dd className="ub-mono break-all text-[10.5px]">{event.entryHash}</dd>
              </div>
              <div className="sm:col-span-2">
                <dt className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">Hash poprzedni</dt>
                <dd className="ub-mono break-all text-[10.5px]">{event.prevHash}</dd>
              </div>
              {event.details !== null && event.details !== undefined && (
                <div className="sm:col-span-2">
                  <dt className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">Szczegóły</dt>
                  <dd>
                    <pre className="ub-mono max-h-40 overflow-auto rounded bg-[var(--ub-bg-panel)] p-2 text-[10.5px]">
                      {JSON.stringify(event.details, null, 2)}
                    </pre>
                  </dd>
                </div>
              )}
            </dl>
          </td>
        </tr>
      )}
    </>
  );
}
