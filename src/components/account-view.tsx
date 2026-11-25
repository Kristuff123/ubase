"use client";

/**
 * Moje konto: zmiana hasła oraz włączenie 2FA (QR + kody odzyskiwania).
 * Kody odzyskiwania pokazujemy raz — użytkownik musi je zapisać.
 */
import { useState } from "react";
import { useRouter } from "next/navigation";
import { ApiError, api, copyToClipboard } from "@/lib/client";
import type { SessionUser } from "@/lib/auth/server";
import { toast } from "@/components/toast";

const ROLE_LABELS: Record<string, string> = { admin: "Administrator", operator: "Operator", audytor: "Audytor" };

export function AccountView({ user }: { user: SessionUser }) {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [repeat, setRepeat] = useState("");
  const [passwordBusy, setPasswordBusy] = useState(false);
  const [passwordError, setPasswordError] = useState<string | null>(null);

  const [enrollment, setEnrollment] = useState<{
    qrDataUrl: string;
    secret: string;
    recoveryCodes: string[];
  } | null>(null);
  const [enrollBusy, setEnrollBusy] = useState(false);
  const [enrollError, setEnrollError] = useState<string | null>(null);
  const [codesAcknowledged, setCodesAcknowledged] = useState(false);

  const changePassword = async (event: React.FormEvent) => {
    event.preventDefault();
    setPasswordError(null);
    if (next !== repeat) {
      setPasswordError("Nowe hasła nie są identyczne");
      return;
    }
    setPasswordBusy(true);
    try {
      await api("/api/account/password", { body: { currentPassword: current, newPassword: next } });
      toast("Hasło zmienione");
      setCurrent("");
      setNext("");
      setRepeat("");
    } catch (reason) {
      setPasswordError(reason instanceof ApiError ? reason.message : "Nie udało się zmienić hasła");
    } finally {
      setPasswordBusy(false);
    }
  };

  const enroll = async () => {
    setEnrollError(null);
    setEnrollBusy(true);
    try {
      const data = await api<{ qrDataUrl: string; secret: string; recoveryCodes: string[] }>("/api/account/2fa", {
        body: {},
      });
      setEnrollment(data);
      setCodesAcknowledged(false);
    } catch (reason) {
      setEnrollError(reason instanceof ApiError ? reason.message : "Nie udało się włączyć 2FA");
    } finally {
      setEnrollBusy(false);
    }
  };

  return (
    <div className="mx-auto max-w-3xl px-4 py-6 md:px-8 md:py-8">
      <header className="mb-6">
        <h1 className="text-[20px] font-semibold tracking-tight">Moje konto</h1>
        <p className="mt-0.5 text-[12.5px] text-[var(--ub-text-dim)]">
          {user.displayName} · <span className="ub-mono">{user.username}</span> · {ROLE_LABELS[user.role] ?? user.role}
        </p>
      </header>

      <section className="ub-card mb-4 p-5">
        <div className="mb-4 flex items-start justify-between gap-3">
          <div>
            <h2 className="text-[14px] font-semibold">Uwierzytelnianie dwuskładnikowe</h2>
            <p className="mt-0.5 text-[12px] text-[var(--ub-text-muted)]">
              Kod z aplikacji (Google Authenticator, Aegis, 1Password) przy każdym logowaniu.
            </p>
          </div>
          {user.totpEnabled ? (
            <span className="ub-chip ub-chip-ok shrink-0">włączone</span>
          ) : (
            <span className="ub-chip ub-chip-warn shrink-0">wyłączone</span>
          )}
        </div>

        {user.totpEnabled ? (
          <p className="text-[12px] text-[var(--ub-text-muted)]">
            2FA jest aktywne. Jeśli zgubisz telefon, użyj kodu odzyskiwania — albo poproś administratora o reset.
            Ponowne włączenie wygeneruje nowy sekret i unieważni stare kody odzyskiwania.
          </p>
        ) : enrollment ? (
          <div className="space-y-4">
            <div className="flex flex-wrap gap-5">
              {/* eslint-disable-next-line @next/next/no-img-element */}
              <img src={enrollment.qrDataUrl} alt="Kod QR do aplikacji uwierzytelniającej" width={180} height={180} className="rounded-[var(--ub-radius)] border border-[var(--ub-border)] bg-white p-2" />
              <div className="min-w-[200px] flex-1">
                <p className="text-[12px] font-medium">1. Zeskanuj kod QR</p>
                <p className="mt-0.5 text-[11.5px] text-[var(--ub-text-dim)]">albo wpisz sekret ręcznie:</p>
                <div className="mt-1.5 flex items-center gap-1.5">
                  <code className="ub-mono flex-1 break-all rounded bg-[var(--ub-bg-input)] px-2 py-1.5 text-[11px]">
                    {enrollment.secret}
                  </code>
                  <button
                    type="button"
                    onClick={async () => {
                      if (await copyToClipboard(enrollment.secret)) toast("Sekret skopiowany");
                    }}
                    className="ub-btn ub-btn-secondary shrink-0 px-2 py-1 text-[11px]"
                  >
                    kopiuj
                  </button>
                </div>
              </div>
            </div>

            <div>
              <p className="text-[12px] font-medium">2. Zapisz kody odzyskiwania</p>
              <p className="mt-0.5 text-[11.5px] text-[var(--ub-text-dim)]">
                Każdy działa jednorazowo. To jedyny moment, w którym są widoczne.
              </p>
              <div className="mt-2 grid grid-cols-2 gap-1.5 sm:grid-cols-5">
                {enrollment.recoveryCodes.map((code) => (
                  <code key={code} className="ub-mono rounded border border-[var(--ub-border)] bg-[var(--ub-bg-input)] px-2 py-1 text-center text-[11px]">
                    {code}
                  </code>
                ))}
              </div>
              <div className="mt-2 flex flex-wrap gap-2">
                <button
                  type="button"
                  onClick={async () => {
                    const text = enrollment.recoveryCodes.join("\n");
                    if (await copyToClipboard(text)) toast("Kody skopiowane — zapisz je poza tym komputerem");
                  }}
                  className="ub-btn ub-btn-secondary text-[11.5px]"
                >
                  Kopiuj wszystkie
                </button>
                <button
                  type="button"
                  onClick={() => {
                    const blob = new Blob([`Kody odzyskiwania userbase — ${user.username}\n\n${enrollment.recoveryCodes.join("\n")}\n`], {
                      type: "text/plain",
                    });
                    const url = URL.createObjectURL(blob);
                    const link = document.createElement("a");
                    link.href = url;
                    link.download = `kody-odzyskiwania-${user.username}.txt`;
                    link.click();
                    URL.revokeObjectURL(url);
                  }}
                  className="ub-btn ub-btn-secondary text-[11.5px]"
                >
                  Pobierz .txt
                </button>
              </div>
            </div>

            <label className="flex items-center gap-2 text-[12px] text-[var(--ub-text-muted)]">
              <input
                type="checkbox"
                checked={codesAcknowledged}
                onChange={(event) => setCodesAcknowledged(event.target.checked)}
                className="h-3.5 w-3.5 accent-[var(--ub-accent)]"
              />
              Zapisałem kody odzyskiwania w bezpiecznym miejscu
            </label>

            <div className="flex gap-2">
              <button
                type="button"
                disabled={!codesAcknowledged}
                onClick={() => {
                  setEnrollment(null);
                  toast("2FA aktywne przy następnym logowaniu");
                  router.refresh();
                }}
                className="ub-btn ub-btn-primary"
              >
                Zakończ
              </button>
              <button type="button" onClick={() => setEnrollment(null)} className="ub-btn ub-btn-ghost">
                Zamknij
              </button>
            </div>
          </div>
        ) : (
          <>
            <button type="button" onClick={() => void enroll()} disabled={enrollBusy} className="ub-btn ub-btn-primary">
              {enrollBusy ? "Generowanie…" : "Włącz 2FA"}
            </button>
            {enrollError && <p className="mt-2 text-[12px] text-[var(--ub-danger)]">{enrollError}</p>}
          </>
        )}
      </section>

      <section className="ub-card p-5">
        <h2 className="text-[14px] font-semibold">Zmiana hasła</h2>
        <p className="mt-0.5 mb-3 text-[12px] text-[var(--ub-text-muted)]">
          Minimum 12 znaków. Zmiana wylogowuje wszystkie inne sesje.
        </p>
        <form onSubmit={changePassword} className="max-w-sm space-y-3">
          <div>
            <label htmlFor="cp-current" className="ub-label">Obecne hasło</label>
            <input id="cp-current" type="password" value={current} onChange={(event) => setCurrent(event.target.value)} required autoComplete="current-password" className="ub-input" />
          </div>
          <div>
            <label htmlFor="cp-new" className="ub-label">Nowe hasło</label>
            <input id="cp-new" type="password" value={next} onChange={(event) => setNext(event.target.value)} required minLength={12} autoComplete="new-password" className="ub-input" />
          </div>
          <div>
            <label htmlFor="cp-repeat" className="ub-label">Powtórz nowe hasło</label>
            <input id="cp-repeat" type="password" value={repeat} onChange={(event) => setRepeat(event.target.value)} required minLength={12} autoComplete="new-password" className="ub-input" />
          </div>
          {passwordError && <p className="text-[12px] text-[var(--ub-danger)]">{passwordError}</p>}
          <button type="submit" disabled={passwordBusy} className="ub-btn ub-btn-primary">
            {passwordBusy ? "Zmiana…" : "Zmień hasło"}
          </button>
        </form>
      </section>
    </div>
  );
}
