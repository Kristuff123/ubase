"use client";

/**
 * Logowanie dwuetapowe:
 * 1. login + hasło, 2. kod TOTP (jeśli konto ma 2FA).
 * Po sukcesie: przekierowanie do / lub wymuszona zmiana hasła.
 */
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useState } from "react";

function LoginForm() {
  const router = useRouter();
  const params = useSearchParams();
  const [step, setStep] = useState<"credentials" | "totp">("credentials");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [mustChange, setMustChange] = useState(false);

  useEffect(() => {
    if (params.get("expired")) setError("Sesja wygasła — zaloguj się ponownie.");
  }, [params]);

  const submitCredentials = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/login", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      const data = (await response.json()) as {
        status?: string;
        error?: string;
        user?: { mustChangePassword: boolean };
      };
      if (!response.ok) {
        setError(data.error ?? "Nie udało się zalogować");
        return;
      }
      if (data.status === "pending_2fa") {
        setStep("totp");
        return;
      }
      if (data.user?.mustChangePassword) {
        setMustChange(true);
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  const submitTotp = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const response = await fetch("/api/auth/2fa", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ code }),
      });
      const data = (await response.json()) as { status?: string; error?: string; user?: { mustChangePassword: boolean } };
      if (!response.ok) {
        setError(data.error ?? "Nieprawidłowy kod");
        return;
      }
      if (data.user?.mustChangePassword) {
        setMustChange(true);
        return;
      }
      router.replace("/");
      router.refresh();
    } finally {
      setBusy(false);
    }
  };

  if (mustChange) {
    return (
      <div className="ub-card ub-fade-in w-full max-w-sm p-6">
        <h2 className="mb-1 text-[15px] font-semibold">Zmiana hasła wymagana</h2>
        <p className="mb-4 text-[12.5px] text-[var(--ub-text-muted)]">
          To konto ma hasło startowe. Ustaw własne, żeby kontynuować.
        </p>
        <ChangePasswordForm onDone={() => { router.replace("/"); router.refresh(); }} />
      </div>
    );
  }

  return (
    <div className="ub-card ub-fade-in w-full max-w-sm p-6 shadow-[var(--ub-shadow-lg)]">
      <div className="mb-6 flex items-center gap-3">
        <div className="flex h-10 w-10 items-center justify-center rounded-[10px] bg-[var(--ub-accent)] text-[#17130a]">
          <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
            <rect x="4" y="10" width="16" height="10" rx="2" />
            <path d="M8 10V7a4 4 0 0 1 8 0v3" />
          </svg>
        </div>
        <div>
          <h1 className="text-[15px] font-semibold leading-tight">Userbase</h1>
          <p className="text-[11.5px] text-[var(--ub-text-dim)]">baza pracowników i dostępów</p>
        </div>
      </div>

      {step === "credentials" ? (
        <form onSubmit={submitCredentials} className="space-y-3">
          <div>
            <label htmlFor="username" className="ub-label">
              Login
            </label>
            <input
              id="username"
              value={username}
              onChange={(event) => setUsername(event.target.value)}
              autoComplete="username"
              autoFocus
              required
              className="ub-input"
              placeholder="np. jkowalski"
            />
          </div>
          <div>
            <label htmlFor="password" className="ub-label">
              Hasło
            </label>
            <input
              id="password"
              type="password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="current-password"
              required
              className="ub-input"
              placeholder="••••••••••••"
            />
          </div>

          {error && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="ub-btn ub-btn-primary w-full py-2.5">
            {busy ? "Sprawdzanie…" : "Zaloguj się"}
          </button>

          <p className="pt-1 text-center text-[11px] leading-relaxed text-[var(--ub-text-dim)]">
            Dostęp wyłącznie dla działu IT. Zdarzenia logowania są rejestrowane.
          </p>
        </form>
      ) : (
        <form onSubmit={submitTotp} className="space-y-3">
          <div className="rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] bg-[var(--ub-bg-input)] px-3 py-2 text-[12px] text-[var(--ub-text-muted)]">
            Wpisz 6-cyfrowy kod z aplikacji uwierzytelniającej albo kod odzyskiwania.
          </div>
          <div>
            <label htmlFor="code" className="ub-label">
              Kod
            </label>
            <input
              id="code"
              value={code}
              onChange={(event) => setCode(event.target.value)}
              autoComplete="one-time-code"
              inputMode="numeric"
              autoFocus
              required
              className="ub-input ub-mono text-center text-[20px] tracking-[0.3em]"
              placeholder="000000"
              maxLength={9}
            />
          </div>

          {error && (
            <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
              {error}
            </div>
          )}

          <button type="submit" disabled={busy} className="ub-btn ub-btn-primary w-full py-2.5">
            {busy ? "Weryfikacja…" : "Potwierdź kod"}
          </button>
          <button
            type="button"
            onClick={() => {
              setStep("credentials");
              setCode("");
              setError(null);
            }}
            className="ub-btn ub-btn-ghost w-full"
          >
            Wróć
          </button>
        </form>
      )}
    </div>
  );
}

function ChangePasswordForm({ onDone }: { onDone: () => void }) {
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    setError(null);
    if (next !== repeat) {
      setError("Hasła nie są identyczne");
      return;
    }
    setBusy(true);
    try {
      // CSRF double-submit: serwer wymaga nagłówka zgodnego z cookie `ub_csrf`.
      // Bez niego endpoint zwraca 403 i konto z hasłem startowym byłoby trwale
      // zablokowane — to jedyny formularz działający jeszcze przed pełnym
      // zalogowaniem, więc nie korzysta ze wspólnego klienta `api()` z komponentów.
      const csrf = document.cookie.match(/(?:^|;\s*)ub_csrf=([^;]+)/)?.[1] ?? "";
      const response = await fetch("/api/account/password", {
        method: "POST",
        headers: { "Content-Type": "application/json", "X-CSRF-Token": decodeURIComponent(csrf) },
        body: JSON.stringify({ currentPassword: current, newPassword: next }),
      });
      const data = (await response.json()) as { error?: string };
      if (!response.ok) {
        setError(data.error ?? "Nie udało się zmienić hasła");
        return;
      }
      onDone();
    } finally {
      setBusy(false);
    }
  };

  return (
    <form onSubmit={submit} className="space-y-3">
      <div>
        <label htmlFor="cur" className="ub-label">
          Obecne hasło
        </label>
        <input id="cur" type="password" value={current} onChange={(e) => setCurrent(e.target.value)} required className="ub-input" autoComplete="current-password" />
      </div>
      <div>
        <label htmlFor="new" className="ub-label">
          Nowe hasło (min. 12 znaków)
        </label>
        <input id="new" type="password" value={next} onChange={(e) => setNext(e.target.value)} required minLength={12} className="ub-input" autoComplete="new-password" />
      </div>
      <div>
        <label htmlFor="rep" className="ub-label">
          Powtórz nowe hasło
        </label>
        <input id="rep" type="password" value={repeat} onChange={(e) => setRepeat(e.target.value)} required minLength={12} className="ub-input" autoComplete="new-password" />
      </div>
      {error && (
        <div className="rounded-[var(--ub-radius-sm)] border border-[rgba(242,85,90,0.35)] bg-[var(--ub-danger-soft)] px-3 py-2 text-[12px] text-[var(--ub-danger)]">
          {error}
        </div>
      )}
      <button type="submit" disabled={busy} className="ub-btn ub-btn-primary w-full py-2.5">
        {busy ? "Zapisywanie…" : "Ustaw hasło"}
      </button>
    </form>
  );
}

export default function LoginPage() {
  return (
    <div className="flex min-h-dvh items-center justify-center px-4 py-10">
      <Suspense fallback={<div className="text-[13px] text-[var(--ub-text-dim)]">Ładowanie…</div>}>
        <LoginForm />
      </Suspense>
    </div>
  );
}
