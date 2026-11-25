"use client";

/**
 * Formularz dostępu: pola budowane dynamicznie ze schematu kategorii.
 * Obsługuje warunki showWhen, generator haseł i tryb edycji bez nadpisywania sekretów.
 */
import { useEffect, useMemo, useState } from "react";
import type { AccessView, FieldDef } from "@/lib/domain/types";
import { ApiError, api, copyToClipboard } from "@/lib/client";
import { toast } from "@/components/toast";

type Unit = { id: number; type: string; name: string; number: string | null };
type Category = { id: number; slug: string; name: string; fields: FieldDef[] };

/** Sentinel zgodny z serwerem: „zostaw dotychczasową wartość". */
const KEEP_SECRET = "__KEEP__";

type Values = Record<string, string | string[]>;

function unitOptions(units: Unit[], type: string | undefined): Unit[] {
  const filtered = type ? units.filter((unit) => unit.type === type) : units;
  return [...filtered].sort((a, b) => a.name.localeCompare(b.name, "pl"));
}

function unitLabel(unit: Unit): string {
  const number = unit.number ? `${unit.number} · ` : "";
  const prefix = unit.type === "zaklad" ? "🏭" : unit.type === "region" ? "🗺" : unit.type === "biuro" ? "🏢" : "🏬";
  return `${prefix} ${number}${unit.name}`;
}

export function AccessFormDialog({
  mode,
  workerId,
  categories,
  unitsAll,
  access,
  onClose,
  onSaved,
}: {
  mode: "add" | "edit";
  workerId: number;
  categories: Category[];
  unitsAll: Unit[];
  access?: AccessView;
  onClose: () => void;
  onSaved: () => void;
}) {
  const initialCategory =
    categories.find((category) => category.slug === access?.categorySlug) ?? categories[0];

  const [categoryId, setCategoryId] = useState<number>(initialCategory?.id ?? 0);
  const [title, setTitle] = useState(access?.title ?? "");
  const [resourceOwner, setResourceOwner] = useState<"firma" | "pracownik">(access?.resourceOwner ?? "firma");
  const [values, setValues] = useState<Values>(() => initialValues(access));
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [generating, setGenerating] = useState<string | null>(null);

  const category = categories.find((item) => item.id === categoryId) ?? categories[0];
  const schema = category?.fields ?? [];

  const visible = useMemo(() => {
    return schema.filter((field) => {
      if (!field.showWhen) return true;
      return Object.entries(field.showWhen).every(([key, allowed]) => {
        const raw = values[key];
        const list = Array.isArray(raw) ? raw : raw ? [raw] : [];
        return list.some((value) => allowed.includes(value));
      });
    });
  }, [schema, values]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onClose]);

  const setValue = (key: string, value: string | string[]) => {
    setValues((current) => ({ ...current, [key]: value }));
  };

  const generate = async (fieldKey: string, strong: boolean) => {
    setGenerating(fieldKey);
    try {
      const result = await api<{ password: string }>(
        `/api/generator?length=8&maxDigits=3${strong ? "&strong=1" : ""}`,
      );
      setValue(fieldKey, result.password);
      toast(`Wygenerowano hasło: ${result.password}`, "info");
    } catch (reason) {
      toast(reason instanceof ApiError ? reason.message : "Generator niedostępny", "error");
    } finally {
      setGenerating(null);
    }
  };

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);

    // Pole wymagane, ukryte przez showWhen, nie powinno blokować zapisu.
    const payloadValues: Values = {};
    for (const field of visible) {
      payloadValues[field.key] = values[field.key] || field.defaultValue || (field.type === "multiselect" ? [] : "");
    }

    setBusy(true);
    try {
      if (mode === "add") {
        await api(`/api/workers/${workerId}/accesses`, {
          body: { categoryId: category.id, title: title.trim() || null, resourceOwner, values: payloadValues },
        });
        toast(`Dodano dostęp: ${title.trim() || category.name}`);
      } else if (access) {
        await api(`/api/accesses/${access.id}`, {
          method: "PATCH",
          body: { categoryId: category.id, title: title.trim() || null, resourceOwner, values: payloadValues },
        });
        toast("Zapisano zmiany w dostępie");
      }
      onSaved();
    } catch (reason) {
      setError(reason instanceof ApiError ? reason.message : "Nie udało się zapisać");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-start justify-center overflow-y-auto bg-black/60 px-4 py-8 backdrop-blur-sm" onClick={onClose} role="presentation">
      <div
        className="ub-card ub-fade-in w-full max-w-xl shadow-[var(--ub-shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label={mode === "add" ? "Nowy dostęp" : "Edycja dostępu"}
      >
        <div className="flex items-start justify-between border-b border-[var(--ub-border)] px-5 py-3.5">
          <div>
            <h2 className="text-[15px] font-semibold">{mode === "add" ? "Nowy dostęp" : "Edycja dostępu"}</h2>
            <p className="text-[11.5px] text-[var(--ub-text-dim)]">
              Sekrety są szyfrowane AES-256-GCM; w podglądzie widoczne jako kropki.
            </p>
          </div>
          <button type="button" onClick={onClose} className="ub-btn ub-btn-ghost px-2" aria-label="Zamknij">
            ✕
          </button>
        </div>

        <form onSubmit={submit} className="max-h-[70vh] space-y-3.5 overflow-y-auto px-5 py-4">
          <div className="grid gap-3 sm:grid-cols-2">
            <div>
              <label htmlFor="acc-cat" className="ub-label">
                Kategoria
              </label>
              <select
                id="acc-cat"
                value={categoryId}
                onChange={(event) => {
                  setCategoryId(Number(event.target.value));
                  setValues({});
                }}
                disabled={mode === "edit"}
                className="ub-input"
              >
                {categories.map((item) => (
                  <option key={item.id} value={item.id}>
                    {item.name}
                  </option>
                ))}
              </select>
            </div>
            <div>
              <label htmlFor="acc-owner" className="ub-label">
                Czyj zasób
              </label>
              <select
                id="acc-owner"
                value={resourceOwner}
                onChange={(event) => setResourceOwner(event.target.value as "firma" | "pracownik")}
                className="ub-input"
              >
                <option value="firma">Konto firmowe / wspólne</option>
                <option value="pracownik">Konto pracownika</option>
              </select>
            </div>
          </div>

          <div>
            <label htmlFor="acc-title" className="ub-label">
              Nazwa / opis (opcjonalnie)
            </label>
            <input
              id="acc-title"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
              className="ub-input"
              placeholder="np. chip do bramy głównej, Axel — piekarnia"
            />
          </div>

          {schema.length === 0 && (
            <p className="rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] bg-[var(--ub-bg-input)] px-3 py-2.5 text-[12px] text-[var(--ub-text-muted)]">
              Ta kategoria nie ma zdefiniowanych pól. Użyj nazwy/opisu powyżej, aby zapisać, co to za dostęp
              (własne pola kategorii „Inne” ustawisz w Administracji).
            </p>
          )}

          {visible.map((field) => {
            const raw = values[field.key] || field.defaultValue;
            const text = Array.isArray(raw) ? raw.join(", ") : (raw ?? "");
            const id = `acc-${field.key}`;

            if (field.type === "multiselect") {
              const selected = Array.isArray(raw) ? raw : [];
              return (
                <fieldset key={field.key}>
                  <legend className="ub-label">
                    {field.label}
                    {field.required && <span className="text-[var(--ub-danger)]"> *</span>}
                  </legend>
                  <div className="flex flex-wrap gap-1.5">
                    {(field.options ?? []).map((option) => {
                      const active = selected.includes(option);
                      return (
                        <button
                          key={option}
                          type="button"
                          onClick={() =>
                            setValue(
                              field.key,
                              active ? selected.filter((item) => item !== option) : [...selected, option],
                            )
                          }
                          className={`ub-chip transition-colors ${active ? "ub-chip-accent" : "hover:text-[var(--ub-text)]"}`}
                          aria-pressed={active}
                        >
                          {option}
                        </button>
                      );
                    })}
                  </div>
                  {field.help && <p className="mt-1 text-[11px] text-[var(--ub-text-dim)]">{field.help}</p>}
                </fieldset>
              );
            }

            if (field.type === "select") {
              return (
                <div key={field.key}>
                  <label htmlFor={id} className="ub-label">
                    {field.label}
                    {field.required && <span className="text-[var(--ub-danger)]"> *</span>}
                  </label>
                  <select
                    id={id}
                    value={text}
                    onChange={(event) => setValue(field.key, event.target.value)}
                    className="ub-input"
                  >
                    {!field.defaultValue && <option value="">— wybierz —</option>}
                    {(field.options ?? []).map((option) => (
                      <option key={option} value={option}>
                        {option}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (field.type === "ref_org_unit") {
              const options = unitOptions(unitsAll, field.unitType);
              return (
                <div key={field.key}>
                  <label htmlFor={id} className="ub-label">
                    {field.label}
                    {field.required && <span className="text-[var(--ub-danger)]"> *</span>}
                  </label>
                  <select
                    id={id}
                    value={text}
                    onChange={(event) => setValue(field.key, event.target.value)}
                    className="ub-input"
                  >
                    <option value="">— wybierz —</option>
                    {options.map((unit) => (
                      <option key={unit.id} value={String(unit.id)}>
                        {unitLabel(unit)}
                      </option>
                    ))}
                  </select>
                </div>
              );
            }

            if (field.type === "checkbox") {
              return (
                <label key={field.key} className="flex items-start gap-2.5 rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] px-3 py-2">
                  <input
                    type="checkbox"
                    checked={text === "tak"}
                    onChange={(event) => setValue(field.key, event.target.checked ? "tak" : "")}
                    className="mt-0.5 h-3.5 w-3.5 accent-[var(--ub-accent)]"
                  />
                  <span className="text-[12.5px] text-[var(--ub-text-muted)]">{field.label}</span>
                </label>
              );
            }

            if (field.type === "textarea") {
              return (
                <div key={field.key}>
                  <label htmlFor={id} className="ub-label">
                    {field.label}
                    {field.required && <span className="text-[var(--ub-danger)]"> *</span>}
                  </label>
                  <textarea
                    id={id}
                    value={text}
                    onChange={(event) => setValue(field.key, event.target.value)}
                    rows={3}
                    className="ub-input ub-mono resize-y"
                    placeholder={field.placeholder}
                  />
                </div>
              );
            }

            const isSecret = Boolean(field.secret || field.type === "password");
            const kept = text === KEEP_SECRET;
            const isChipNumber = category.slug === "chip" && field.key === "number";
            const isHex = values.number_format === "szesnastkowo";

            return (
              <div key={field.key}>
                <label htmlFor={id} className="ub-label">
                  {field.label}
                  {field.required && !kept && <span className="text-[var(--ub-danger)]"> *</span>}
                </label>
                <div className="flex gap-1.5">
                  <input
                    id={id}
                    type={isSecret && !kept ? "password" : field.type === "date" ? "date" : "text"}
                    value={kept ? "" : text}
                    onChange={(event) => setValue(field.key, event.target.value)}
                    className={`ub-input ${isSecret ? "ub-mono" : ""}`}
                    placeholder={kept ? "•••••••• (bez zmian)" : field.placeholder}
                    autoComplete="off"
                  />
                  {isSecret && (
                    <>
                      <button
                        type="button"
                        onClick={() => void generate(field.key, false)}
                        disabled={generating === field.key}
                        className="ub-btn ub-btn-secondary shrink-0 px-2.5"
                        title="Wygeneruj hasło 8 znaków (małe litery, max 3 cyfry)"
                      >
                        {generating === field.key ? "…" : "🎲"}
                      </button>
                      <button
                        type="button"
                        onClick={async () => {
                          if (await copyToClipboard(text)) toast("Skopiowano");
                        }}
                        disabled={!text || kept}
                        className="ub-btn ub-btn-secondary shrink-0 px-2.5"
                        title="Kopiuj"
                      >
                        ⧉
                      </button>
                    </>
                  )}
                  {kept && (
                    <button
                      type="button"
                      onClick={() => setValue(field.key, "")}
                      className="ub-btn ub-btn-secondary shrink-0 px-2 text-[11px]"
                      title="Podaj nową wartość"
                    >
                      zmień
                    </button>
                  )}
                </div>
                {isSecret && !kept && (
                  <label className="mt-1 flex items-center gap-1.5 text-[11px] text-[var(--ub-text-dim)]">
                    <input
                      type="checkbox"
                      checked={text.length > 0 && /[A-Z]|[^a-z0-9]/.test(text)}
                      onChange={(event) => {
                        if (!event.target.checked) return;
                        void generate(field.key, true);
                      }}
                      className="h-3 w-3 accent-[var(--ub-accent)]"
                    />
                    mocniejsze (znak specjalny + wielka litera)
                  </label>
                )}
                {field.help && <p className="mt-1 text-[11px] text-[var(--ub-text-dim)]">{field.help}</p>}
              </div>
            );
          })}

          {error && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
              {error}
            </div>
          )}

          <div className="flex gap-2 pt-1">
            <button type="submit" disabled={busy} className="ub-btn ub-btn-primary flex-1 py-2.5">
              {busy ? "Zapisywanie…" : mode === "add" ? "Dodaj dostęp" : "Zapisz zmiany"}
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

/** Wypełnia formularz edycji; sekrety startują jako „bez zmian". */
function initialValues(access?: AccessView): Values {
  if (!access) return {};
  const out: Values = {};
  for (const field of access.fields) {
    if (field.secret) {
      out[field.key] = field.hasValue ? KEEP_SECRET : "";
      continue;
    }
    out[field.key] = field.type === "multiselect" ? [...field.values] : (field.values[0] ?? "");
  }
  return out;
}

export { KEEP_SECRET };
