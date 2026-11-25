"use client";

/**
 * Paleta poleceń (/ lub Ctrl+K): szybkie przejście do pracownika lub sekcji.
 * Wyszukiwanie po stronie serwera z debounce, nawigacja klawiaturą.
 */
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState } from "react";

type Result = {
  id: number;
  firstName: string;
  lastName: string;
  orgUnitName: string | null;
  status: string;
};

const SECTIONS = [
  { href: "/", label: "Pracownicy" },
  { href: "/audyt", label: "Audyt" },
  { href: "/import", label: "Import z Excela" },
  { href: "/administracja", label: "Administracja" },
  { href: "/konto", label: "Moje konto" },
];

export function CommandPalette({
  open,
  onClose,
  role,
}: {
  open: boolean;
  onClose: () => void;
  role: string;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Result[]>([]);
  const [cursor, setCursor] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setQuery("");
      setResults([]);
      setCursor(0);
      setTimeout(() => inputRef.current?.focus(), 20);
    }
  }, [open]);

  useEffect(() => {
    if (!open || query.trim().length < 2) {
      setResults([]);
      return;
    }
    const controller = new AbortController();
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`/api/workers?q=${encodeURIComponent(query)}&limit=6`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const data = (await response.json()) as { items: Result[] };
        setResults(data.items);
        setCursor(0);
      } catch {
        /* przerwane żądanie */
      }
    }, 150);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [query, open]);

  const sections = SECTIONS.filter((section) =>
    section.href === "/import" || section.href === "/administracja" ? ["admin", "operator"].includes(role) : true,
  ).filter(
    (section) => section.href !== "/administracja" || role === "admin",
  );

  const filteredSections = query.trim()
    ? sections.filter((section) => section.label.toLowerCase().includes(query.toLowerCase()))
    : sections;

  const total = results.length + filteredSections.length;

  const go = (index: number) => {
    if (index < results.length) {
      const item = results[index];
      router.push(`/pracownicy/${item.id}`);
    } else {
      const section = filteredSections[index - results.length];
      if (section) router.push(section.href);
    }
    onClose();
  };

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/60 px-4 pt-[12vh] backdrop-blur-sm"
      onClick={onClose}
      role="presentation"
    >
      <div
        className="ub-card ub-fade-in w-full max-w-lg overflow-hidden shadow-[var(--ub-shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Szukaj i przejdź"
      >
        <div className="flex items-center gap-2 border-b border-[var(--ub-border)] px-4 py-3">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" className="text-[var(--ub-text-dim)]" aria-hidden>
            <circle cx="11" cy="11" r="8" />
            <path d="m21 21-4.3-4.3" />
          </svg>
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => {
              setQuery(event.target.value);
              setCursor(0);
            }}
            onKeyDown={(event) => {
              if (event.key === "Escape") onClose();
              if (event.key === "ArrowDown") {
                event.preventDefault();
                setCursor((c) => (total ? (c + 1) % total : 0));
              }
              if (event.key === "ArrowUp") {
                event.preventDefault();
                setCursor((c) => (total ? (c - 1 + total) % total : 0));
              }
              if (event.key === "Enter") go(cursor);
            }}
            placeholder="Szukaj pracownika, przejdź do sekcji…"
            className="flex-1 bg-transparent text-[14px] text-[var(--ub-text)] outline-none placeholder:text-[var(--ub-text-dim)]"
            aria-label="Szukaj"
          />
          <kbd className="rounded border border-[var(--ub-border-strong)] px-1.5 py-0.5 text-[10px] text-[var(--ub-text-dim)]">Esc</kbd>
        </div>

        <div className="max-h-80 overflow-y-auto py-1">
          {results.map((item, index) => (
            <button
              key={`w-${item.id}`}
              type="button"
              onMouseEnter={() => setCursor(index)}
              onClick={() => go(index)}
              className={`flex w-full items-center gap-3 px-4 py-2 text-left ${
                cursor === index ? "bg-[var(--ub-bg-hover)]" : ""
              }`}
            >
              <span className="flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-[var(--ub-bg-hover)] text-[10px] font-semibold text-[var(--ub-text-muted)]">
                {item.firstName[0]}
                {item.lastName[0]}
              </span>
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px]">
                  {item.firstName} {item.lastName}
                </span>
                <span className="block truncate text-[11px] text-[var(--ub-text-dim)]">{item.orgUnitName ?? "—"}</span>
              </span>
              {item.status === "zarchiwizowany" && <span className="ub-chip">archiwum</span>}
            </button>
          ))}

          {filteredSections.map((section, index) => {
            const active = cursor === results.length + index;
            return (
              <button
                key={section.href}
                type="button"
                onMouseEnter={() => setCursor(results.length + index)}
                onClick={() => go(results.length + index)}
                className={`flex w-full items-center gap-3 px-4 py-2 text-left text-[13px] ${
                  active ? "bg-[var(--ub-bg-hover)]" : ""
                }`}
              >
                <span className="flex h-6 w-6 items-center justify-center rounded bg-[var(--ub-bg-hover)] text-[10px] text-[var(--ub-text-dim)]">
                  →
                </span>
                {section.label}
              </button>
            );
          })}

          {query.trim().length >= 2 && results.length === 0 && filteredSections.length === 0 && (
            <div className="px-4 py-6 text-center text-[12px] text-[var(--ub-text-dim)]">Brak wyników</div>
          )}
        </div>
      </div>
    </div>
  );
}
