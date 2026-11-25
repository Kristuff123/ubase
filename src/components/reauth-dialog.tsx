"use client";

/**
 * Modal ponownego potwierdzenia hasła.
 * Otwiera 5-minutowe okno „step-up" — bez niego serwer odmawia wydania sekretu.
 */
import { useEffect, useRef, useState } from "react";
import { ApiError, confirmPassword } from "@/lib/client";

export function ReauthDialog({
  open,
  reason,
  onClose,
  onSuccess,
}: {
  open: boolean;
  reason?: string;
  onClose: () => void;
  onSuccess: () => void;
}) {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setPassword("");
      setError(null);
      setTimeout(() => inputRef.current?.focus(), 30);
    }
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const handler = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await confirmPassword(password);
      onSuccess();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "Nie udało się potwierdzić hasła");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 px-4 backdrop-blur-sm" onClick={onClose} role="presentation">
      <div
        className="ub-card ub-fade-in w-full max-w-sm p-5 shadow-[var(--ub-shadow-lg)]"
        onClick={(event) => event.stopPropagation()}
        role="dialog"
        aria-modal="true"
        aria-label="Potwierdź hasło"
      >
        <div className="mb-1 flex items-center gap-2">
          <span className="flex h-7 w-7 items-center justify-center rounded-full bg-[var(--ub-warn-soft)] text-[var(--ub-warn)]">
            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden>
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </span>
          <h2 className="text-[14px] font-semibold">Potwierdź hasło</h2>
        </div>
        <p className="mb-4 text-[12px] leading-relaxed text-[var(--ub-text-muted)]">
          {reason ?? "Operacja dotyczy sekretów. Potwierdzenie jest ważne 5 minut i jest rejestrowane w audycie."}
        </p>

        <form onSubmit={submit} className="space-y-3">
          <div>
            <label htmlFor="reauth-pass" className="ub-label">
              Hasło do konta
            </label>
            <input
              ref={inputRef}
              id="reauth-pass"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="ub-input"
            />
          </div>
          {error && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
              {error}
            </div>
          )}
          <div className="flex gap-2">
            <button type="submit" disabled={busy || !password} className="ub-btn ub-btn-primary flex-1">
              {busy ? "Sprawdzanie…" : "Potwierdź"}
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
