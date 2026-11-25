"use client";

/**
 * Kartoteka pracownika: nagłówek z danymi, karty dostępów, dodawanie/edycja,
 * podejrzenie sekretu za potwierdzeniem hasła, historia zmian, archiwum, eksport RODO.
 */
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useCallback, useEffect, useMemo, useState } from "react";
import type { AccessView, FieldDef, HistoryEntry, WorkerDetail } from "@/lib/domain/types";
import { ApiError, api, copyToClipboard } from "@/lib/client";
import { formatDate, formatDateTime } from "@/lib/utils";
import { AccessFormDialog } from "@/components/access-form";
import { ReauthDialog } from "@/components/reauth-dialog";
import { toast } from "@/components/toast";

type Unit = { id: number; type: string; name: string; number: string | null };
type Category = { id: number; slug: string; name: string; fields: FieldDef[] };

const UNIT_ORDER: Record<string, number> = { zaklad: 0, biuro: 1, region: 2, sklep: 3 };
const UNIT_PREFIX: Record<string, string> = { zaklad: "🏭", biuro: "🏢", region: "🗺", sklep: "🏬" };

export function WorkerDetailView({
  worker,
  role,
  units,
  categories,
}: {
  worker: WorkerDetail;
  role: string;
  units: Unit[];
  categories: Category[];
}) {
  const router = useRouter();
  const canEdit = role === "admin" || role === "operator";
  const canReveal = canEdit;

  const [editOpen, setEditOpen] = useState(false);
  const [accessDialog, setAccessDialog] = useState<{ mode: "add" | "edit"; access?: AccessView } | null>(null);
  const [revealTarget, setRevealTarget] = useState<{ access: AccessView; fieldKey: string } | null>(null);
  const [revealed, setRevealed] = useState<Record<string, { values: string[]; expiresAt: number }>>({});
  const [history, setHistory] = useState<HistoryEntry[] | null>(null);
  const [historyLoading, setHistoryLoading] = useState(false);
  const [confirmRevoke, setConfirmRevoke] = useState<AccessView | null>(null);
  const [busy, setBusy] = useState(false);

  const refresh = useCallback(() => router.refresh(), [router]);

  // Sekrety znikają z ekranu po 30 s — ograniczamy ekspozycję na wypadek otwartego ekranu.
  useEffect(() => {
    const timer = setInterval(() => {
      setRevealed((current) => {
        const next: typeof current = {};
        let changed = false;
        for (const [key, value] of Object.entries(current)) {
          if (value.expiresAt > Date.now()) next[key] = value;
          else changed = true;
        }
        return changed ? next : current;
      });
    }, 1000);
    return () => clearInterval(timer);
  }, []);

  const loadHistory = useCallback(async () => {
    if (history !== null || historyLoading) return;
    setHistoryLoading(true);
    try {
      const data = await api<{ entries: HistoryEntry[] }>(`/api/workers/${worker.id}/history`);
      setHistory(data.entries);
    } catch {
      setHistory([]);
    } finally {
      setHistoryLoading(false);
    }
  }, [history, historyLoading, worker.id]);

  const activeAccesses = worker.accesses.filter((access) => access.status === "aktywny");
  const revokedAccesses = worker.accesses.filter((access) => access.status === "wycofany");
  const unitNames = useMemo(() => new Map(units.map((unit) => [String(unit.id), unit.name])), [units]);

  const archive = async () => {
    if (!window.confirm(`Zarchiwizować ${worker.firstName} ${worker.lastName}? Dostępy pozostaną w historii.`)) return;
    setBusy(true);
    try {
      await api(`/api/workers/${worker.id}/archive`, { body: {} });
      toast("Pracownik przeniesiony do archiwum");
      refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Nie udało się zarchiwizować", "error");
    } finally {
      setBusy(false);
    }
  };

  const restore = async () => {
    setBusy(true);
    try {
      await api(`/api/workers/${worker.id}/restore`, { body: {} });
      toast("Pracownik przywrócony");
      refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Nie udało się przywrócić", "error");
    } finally {
      setBusy(false);
    }
  };

  const revoke = async (access: AccessView) => {
    setBusy(true);
    try {
      await api(`/api/accesses/${access.id}`, { method: "DELETE" });
      toast(`Wycofano dostęp: ${access.title || access.categoryName}`);
      setConfirmRevoke(null);
      refresh();
    } catch (error) {
      toast(error instanceof ApiError ? error.message : "Nie udało się wycofać", "error");
    } finally {
      setBusy(false);
    }
  };

  const doReveal = async (access: AccessView, fieldKey: string) => {
    const key = `${access.id}:${fieldKey}`;
    try {
      const data = await api<{ values: string[] }>(`/api/accesses/${access.id}/reveal`, {
        body: { fieldKey },
      });
      setRevealed((current) => ({
        ...current,
        [key]: { values: data.values, expiresAt: Date.now() + 30_000 },
      }));
      toast("Sekret widoczny przez 30 sekund", "info");
    } catch (error) {
      if (error instanceof ApiError && error.code === "reauth_required") {
        setRevealTarget({ access, fieldKey });
        return;
      }
      toast(error instanceof ApiError ? error.message : "Nie udało się odszyfrować", "error");
    }
  };

  const copy = async (access: AccessView, fieldKey: string, value: string) => {
    const ok = await copyToClipboard(value);
    if (!ok) {
      toast("Nie udało się skopiować — zaznacz i skopiuj ręcznie", "error");
      return;
    }
    toast("Skopiowano do schowka");
    api(`/api/accesses/${access.id}/copied`, { body: { fieldKey } }).catch(() => undefined);
  };

  return (
    <div className="mx-auto max-w-5xl px-4 py-6 md:px-8 md:py-8">
      <div className="mb-5 flex flex-wrap items-center gap-2 text-[12px] text-[var(--ub-text-dim)]">
        <Link href="/" className="hover:text-[var(--ub-text)]">
          Pracownicy
        </Link>
        <span>/</span>
        <span className="text-[var(--ub-text-muted)]">
          {worker.lastName} {worker.firstName}
        </span>
      </div>

      <header className="mb-6 flex flex-wrap items-start justify-between gap-4">
        <div className="flex items-start gap-4">
          <div
            className={`flex h-14 w-14 shrink-0 items-center justify-center rounded-[14px] text-[18px] font-semibold ${
              worker.status === "aktywny"
                ? "bg-[var(--ub-accent-soft)] text-[var(--ub-accent-text)]"
                : "bg-[var(--ub-bg-hover)] text-[var(--ub-text-dim)]"
            }`}
          >
            {worker.firstName[0]}
            {worker.lastName[0]}
          </div>
          <div>
            <div className="flex flex-wrap items-center gap-2.5">
              <h1 className="text-[22px] font-semibold tracking-tight">
                {worker.firstName} {worker.lastName}
              </h1>
              {worker.status === "zarchiwizowany" ? (
                <span className="ub-chip">archiwum</span>
              ) : (
                <span className="ub-chip ub-chip-ok">aktywny</span>
              )}
            </div>
            <p className="mt-1 text-[12.5px] text-[var(--ub-text-muted)]">
              {[worker.position, worker.orgUnitName].filter(Boolean).join(" · ") || "brak stanowiska"}
            </p>
            <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-[11.5px] text-[var(--ub-text-dim)]">
              {worker.email && (
                <a href={`mailto:${worker.email}`} className="hover:text-[var(--ub-text)]">
                  ✉ {worker.email}
                </a>
              )}
              {worker.phone && (
                <a href={`tel:${worker.phone}`} className="hover:text-[var(--ub-text)]">
                  ☎ {worker.phone}
                </a>
              )}
              <span>w bazie od {formatDate(worker.createdAt)}</span>
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-2">
          <a href={`/api/workers/${worker.id}/export`} className="ub-btn ub-btn-secondary">
            Eksport danych
          </a>
          {canEdit && (
            <>
              <button type="button" onClick={() => setEditOpen((open) => !open)} className="ub-btn ub-btn-secondary">
                Edytuj dane
              </button>
              {worker.status === "aktywny" ? (
                <button type="button" onClick={archive} disabled={busy} className="ub-btn ub-btn-danger">
                  Archiwizuj
                </button>
              ) : (
                <button type="button" onClick={restore} disabled={busy} className="ub-btn ub-btn-primary">
                  Przywróć
                </button>
              )}
            </>
          )}
        </div>
      </header>

      {editOpen && canEdit && (
        <EditWorkerForm
          worker={worker}
          units={units}
          onCancel={() => setEditOpen(false)}
          onSaved={() => {
            setEditOpen(false);
            refresh();
          }}
        />
      )}

      {worker.notes && (
        <div className="ub-card mb-5 px-4 py-3">
          <p className="ub-panel-title mb-1">Notatki</p>
          <p className="whitespace-pre-wrap text-[12.5px] text-[var(--ub-text-muted)]">{worker.notes}</p>
        </div>
      )}
      {worker.status === "zarchiwizowany" && (
        <div className="mb-5 rounded-[var(--ub-radius-sm)] border border-[rgba(245,165,36,0.3)] bg-[var(--ub-warn-soft)] px-3.5 py-2.5 text-[12px] text-[var(--ub-warn)]">
          Pracownik jest w archiwum (od {formatDate(worker.archivedAt)}). Dostępy pozostają widoczne w trybie tylko do
          odczytu — jeśli osoba odeszła, wycofaj je osobno, żeby ślad w audycie był jednoznaczny.
        </div>
      )}

      <section className="mb-6">
        <div className="mb-3 flex items-center justify-between">
          <div className="flex items-baseline gap-2">
            <h2 className="text-[14px] font-semibold">Dostępy</h2>
            <span className="text-[12px] text-[var(--ub-text-dim)]">
              {activeAccesses.length} {activeAccesses.length === 1 ? "aktywny" : "aktywnych"}
            </span>
          </div>
          {canEdit && (
            <button type="button" onClick={() => setAccessDialog({ mode: "add" })} className="ub-btn ub-btn-primary">
              <span className="text-[14px] leading-none">+</span> Dodaj dostęp
            </button>
          )}
        </div>

        {activeAccesses.length === 0 ? (
          <div className="ub-card px-5 py-10 text-center">
            <p className="text-[13px] font-medium">Brak aktywnych dostępów</p>
            <p className="mt-1 text-[12px] text-[var(--ub-text-dim)]">
              {canEdit ? "Dodaj chip, Axela, bClient albo inny zasób." : "Ta osoba nie ma przypisanych dostępów."}
            </p>
          </div>
        ) : (
          <div className="grid gap-3 md:grid-cols-2">
            {activeAccesses.map((access) => (
              <AccessCard
                key={access.id}
                access={access}
                unitNames={unitNames}
                canEdit={canEdit}
                canReveal={canReveal}
                revealed={revealed}
                onReveal={doReveal}
                onCopy={copy}
                onEdit={() => setAccessDialog({ mode: "edit", access })}
                onRevoke={() => setConfirmRevoke(access)}
              />
            ))}
          </div>
        )}

        {revokedAccesses.length > 0 && (
          <details className="mt-4">
            <summary className="cursor-pointer text-[12px] text-[var(--ub-text-dim)] hover:text-[var(--ub-text-muted)]">
              Wycofane dostępy ({revokedAccesses.length})
            </summary>
            <div className="mt-2 space-y-1.5">
              {revokedAccesses.map((access) => (
                <div key={access.id} className="flex flex-wrap items-center gap-2 rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] px-3 py-2 text-[12px]">
                  <span className="text-[var(--ub-text-dim)] line-through">{access.title || access.categoryName}</span>
                  <span className="text-[var(--ub-text-dim)]">wycofano {formatDate(access.revokedAt)}</span>
                </div>
              ))}
            </div>
          </details>
        )}
      </section>

      <section className="ub-card overflow-hidden">
        <div className="flex items-center justify-between border-b border-[var(--ub-border)] px-4 py-3">
          <h2 className="text-[14px] font-semibold">Historia zmian</h2>
          {history === null && (
            <button
              type="button"
              onClick={() => void loadHistory()}
              disabled={historyLoading}
              className="text-[12px] text-[var(--ub-accent-text)] hover:underline disabled:opacity-60"
            >
              {historyLoading ? "Wczytywanie…" : "Pokaż"}
            </button>
          )}
        </div>
        {history === null ? (
          <p className="px-4 py-3 text-[12px] text-[var(--ub-text-dim)]">
            Historia zawiera zmiany pól — wartości haseł są w niej zastąpione znacznikiem „[zmieniono]”.
          </p>
        ) : history.length === 0 ? (
          <p className="px-4 py-6 text-center text-[12px] text-[var(--ub-text-dim)]">Brak zapisanych zmian.</p>
        ) : (
          <ul className="ub-divide max-h-80 overflow-y-auto">
            {history.map((entry) => (
              <li key={entry.id} className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 px-4 py-2 text-[12px]">
                <span className="ub-mono text-[11px] text-[var(--ub-text-dim)]">{formatDateTime(entry.changedAt)}</span>
                <span className="font-medium">{entry.fieldKey}</span>
                <span className="text-[var(--ub-text-dim)]">
                  {entry.oldValue ?? "—"} → {entry.newValue ?? "—"}
                </span>
                <span className="ml-auto text-[11px] text-[var(--ub-text-dim)]">{entry.actorName ?? "system"}</span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {accessDialog && (
        <AccessFormDialog
          mode={accessDialog.mode}
          workerId={worker.id}
          categories={categories}
          unitsAll={units}
          access={accessDialog.access}
          onClose={() => setAccessDialog(null)}
          onSaved={() => {
            setAccessDialog(null);
            refresh();
          }}
        />
      )}

      <ReauthDialog
        open={Boolean(revealTarget)}
        reason="Podejrzenie sekretu wymaga ponownego potwierdzenia hasła. Operacja zostanie zapisana w audycie."
        onClose={() => setRevealTarget(null)}
        onSuccess={() => {
          const target = revealTarget;
          setRevealTarget(null);
          if (target) void doReveal(target.access, target.fieldKey);
        }}
      />

      {confirmRevoke && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={() => setConfirmRevoke(null)} role="presentation">
          <div className="ub-card ub-fade-in w-full max-w-sm p-5" onClick={(event) => event.stopPropagation()} role="dialog" aria-modal="true">
            <h2 className="text-[14px] font-semibold">Wycofać dostęp?</h2>
            <p className="mt-1.5 text-[12.5px] text-[var(--ub-text-muted)]">
              „{confirmRevoke.title || confirmRevoke.categoryName}” zostanie oznaczony jako wycofany. Wpis pozostanie w historii audytu.
            </p>
            <div className="mt-4 flex gap-2">
              <button type="button" onClick={() => void revoke(confirmRevoke)} disabled={busy} className="ub-btn ub-btn-danger flex-1">
                Wycofaj
              </button>
              <button type="button" onClick={() => setConfirmRevoke(null)} className="ub-btn ub-btn-secondary">
                Anuluj
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

/* ------------------------------------------------------------------ */

function AccessCard({
  access,
  unitNames,
  canEdit,
  canReveal,
  revealed,
  onReveal,
  onCopy,
  onEdit,
  onRevoke,
}: {
  access: AccessView;
  unitNames: Map<string, string>;
  canEdit: boolean;
  canReveal: boolean;
  revealed: Record<string, { values: string[]; expiresAt: number }>;
  onReveal: (access: AccessView, fieldKey: string) => void;
  onCopy: (access: AccessView, fieldKey: string, value: string) => void;
  onEdit: () => void;
  onRevoke: () => void;
}) {
  const visibleFields = access.fields.filter((field) => field.values.length > 0 || field.type === "ref_org_unit");

  return (
    <article className="ub-card ub-fade-in flex flex-col overflow-hidden">
      <div className="flex items-start justify-between gap-2 border-b border-[var(--ub-border)] px-4 py-2.5">
        <div className="min-w-0">
          <div className="flex items-center gap-1.5">
            <span className="ub-chip ub-chip-accent">{access.categoryName}</span>
            {access.resourceOwner === "firma" ? (
              <span className="text-[10.5px] text-[var(--ub-text-dim)]">konto firmowe</span>
            ) : (
              <span className="text-[10.5px] text-[var(--ub-text-dim)]">konto pracownika</span>
            )}
          </div>
          {access.title && <p className="mt-1 truncate text-[12.5px] font-medium">{access.title}</p>}
        </div>
        {canEdit && (
          <div className="flex shrink-0 gap-0.5">
            <button type="button" onClick={onEdit} className="ub-btn ub-btn-ghost px-1.5 py-1 text-[11px]" aria-label="Edytuj dostęp">
              ✎
            </button>
            <button type="button" onClick={onRevoke} className="ub-btn ub-btn-ghost px-1.5 py-1 text-[11px] text-[var(--ub-danger)]" aria-label="Wycofaj dostęp">
              ✕
            </button>
          </div>
        )}
      </div>

      <dl className="flex-1 space-y-1.5 px-4 py-3">
        {visibleFields.length === 0 && <p className="text-[11.5px] text-[var(--ub-text-dim)]">Brak wypełnionych pól.</p>}
        {visibleFields.map((field) => {
          const key = `${access.id}:${field.key}`;
          const open = revealed[key];
          const isDate = field.type === "date";
          return (
            <div key={field.key} className="flex items-start gap-2 text-[12px]">
              <dt className="w-28 shrink-0 pt-[1px] text-[11px] text-[var(--ub-text-dim)]">{field.label}</dt>
              <dd className="min-w-0 flex-1">
                {field.secret ? (
                  open ? (
                    <span className="flex flex-wrap items-center gap-1.5">
                      <code className="ub-mono break-all rounded bg-[var(--ub-bg-input)] px-1.5 py-0.5 text-[var(--ub-accent-text)]">
                        {open.values.join(", ")}
                      </code>
                      <button
                        type="button"
                        onClick={() => onCopy(access, field.key, open.values.join("\n"))}
                        className="ub-btn ub-btn-ghost px-1 py-0.5 text-[10.5px]"
                      >
                        kopiuj
                      </button>
                      <span className="text-[10px] text-[var(--ub-warn)]">30 s</span>
                    </span>
                  ) : (
                    <span className="flex items-center gap-1.5">
                      <span className="ub-mono tracking-widest text-[var(--ub-text-dim)]">
                        {field.hasValue ? "••••••••" : "—"}
                      </span>
                      {field.hasValue && canReveal && (
                        <button
                          type="button"
                          onClick={() => onReveal(access, field.key)}
                          className="ub-btn ub-btn-ghost px-1 py-0.5 text-[10.5px] text-[var(--ub-accent-text)]"
                        >
                          pokaż
                        </button>
                      )}
                    </span>
                  )
                ) : isDate ? (
                  <span>{formatDate(Date.parse(field.values[0] ?? "") || null)}</span>
                ) : field.type === "ref_org_unit" ? (
                  <span className="break-words">
                    {field.values.map((value) => unitNames.get(value) ?? `#${value}`).join(", ")}
                  </span>
                ) : (
                  <span className="break-words">{field.values.join(", ")}</span>
                )}
              </dd>
            </div>
          );
        })}
      </dl>

      <div className="flex items-center justify-between px-4 pb-2.5 text-[10.5px] text-[var(--ub-text-dim)]">
        <span>dodano {formatDate(access.createdAt)}</span>
        {access.secretsCount > 0 && <span>🔒 {access.secretsCount}</span>}
      </div>
    </article>
  );
}

/* ------------------------------------------------------------------ */

function EditWorkerForm({
  worker,
  units,
  onCancel,
  onSaved,
}: {
  worker: WorkerDetail;
  units: Unit[];
  onCancel: () => void;
  onSaved: () => void;
}) {
  const [firstName, setFirstName] = useState(worker.firstName);
  const [lastName, setLastName] = useState(worker.lastName);
  const [position, setPosition] = useState(worker.position ?? "");
  const [orgUnitId, setOrgUnitId] = useState(worker.orgUnitName ?? "");
  const [email, setEmail] = useState(worker.email ?? "");
  const [phone, setPhone] = useState(worker.phone ?? "");
  const [notes, setNotes] = useState(worker.notes ?? "");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const sorted = useMemo(
    () => [...units].sort((a, b) => (UNIT_ORDER[a.type] ?? 9) - (UNIT_ORDER[b.type] ?? 9) || a.name.localeCompare(b.name, "pl")),
    [units],
  );

  const unitId = units.find((unit) => unit.name === orgUnitId)?.id ?? null;

  const save = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api(`/api/workers/${worker.id}`, {
        method: "PATCH",
        body: { firstName, lastName, position, orgUnitId: unitId, email, phone, notes },
      });
      toast("Zapisano zmiany");
      onSaved();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Nie udało się zapisać");
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={save} className="ub-card ub-fade-in mb-5 p-4">
      <p className="ub-panel-title mb-3">Dane podstawowe</p>
      <div className="grid gap-3 sm:grid-cols-2">
        <div>
          <label className="ub-label" htmlFor="e-fn">Imię</label>
          <input id="e-fn" value={firstName} onChange={(e) => setFirstName(e.target.value)} required className="ub-input" />
        </div>
        <div>
          <label className="ub-label" htmlFor="e-ln">Nazwisko</label>
          <input id="e-ln" value={lastName} onChange={(e) => setLastName(e.target.value)} required className="ub-input" />
        </div>
        <div>
          <label className="ub-label" htmlFor="e-pos">Stanowisko</label>
          <input id="e-pos" value={position} onChange={(e) => setPosition(e.target.value)} className="ub-input" />
        </div>
        <div>
          <label className="ub-label" htmlFor="e-unit">Jednostka</label>
          <select id="e-unit" value={orgUnitId} onChange={(e) => setOrgUnitId(e.target.value)} className="ub-input">
            <option value="">— nie przypisano —</option>
            {sorted.map((unit) => (
              <option key={unit.id} value={unit.name}>
                {UNIT_PREFIX[unit.type] ?? ""} {unit.name}
              </option>
            ))}
          </select>
        </div>
        <div>
          <label className="ub-label" htmlFor="e-mail">E-mail służbowy</label>
          <input id="e-mail" type="email" value={email} onChange={(e) => setEmail(e.target.value)} className="ub-input" />
        </div>
        <div>
          <label className="ub-label" htmlFor="e-phone">Telefon</label>
          <input id="e-phone" value={phone} onChange={(e) => setPhone(e.target.value)} className="ub-input" />
        </div>
        <div className="sm:col-span-2">
          <label className="ub-label" htmlFor="e-notes">Notatki</label>
          <textarea id="e-notes" value={notes} onChange={(e) => setNotes(e.target.value)} rows={2} className="ub-input resize-y" />
        </div>
      </div>
      {error && <p className="mt-3 text-[12px] text-[var(--ub-danger)]">{error}</p>}
      <div className="mt-3 flex gap-2">
        <button type="submit" disabled={busy} className="ub-btn ub-btn-primary">
          {busy ? "Zapisywanie…" : "Zapisz"}
        </button>
        <button type="button" onClick={onCancel} className="ub-btn ub-btn-secondary">
          Anuluj
        </button>
      </div>
    </form>
  );
}
