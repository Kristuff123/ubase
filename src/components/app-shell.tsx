"use client";

/**
 * Szkielet aplikacji: nawigacja boczna + pasek górny.
 * Na ekranie logowania (bez użytkownika) renderuje tylko treść.
 */
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { useCallback, useEffect, useState } from "react";
import type { SessionUser } from "@/lib/auth/server";
import { CommandPalette } from "./command-palette";
import { ThemeToggle } from "./theme-toggle";
import { ToastHost } from "./toast";

const NAV = [
  { href: "/", label: "Pracownicy", icon: "users", roles: ["admin", "operator", "audytor"] },
  { href: "/audyt", label: "Audyt", icon: "shield", roles: ["admin", "operator", "audytor"] },
  { href: "/import", label: "Import", icon: "upload", roles: ["admin", "operator"] },
  { href: "/administracja", label: "Administracja", icon: "settings", roles: ["admin"] },
  { href: "/konto", label: "Moje konto", icon: "key", roles: ["admin", "operator", "audytor"] },
] as const;

function Icon({ name, size = 18 }: { name: string; size?: number }) {
  const common = {
    width: size,
    height: size,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 1.7,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
    "aria-hidden": true,
  };
  switch (name) {
    case "users":
      return (
        <svg {...common}>
          <path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2" />
          <circle cx="9" cy="7" r="4" />
          <path d="M22 21v-2a4 4 0 0 0-3-3.87M16 3.13a4 4 0 0 1 0 7.75" />
        </svg>
      );
    case "shield":
      return (
        <svg {...common}>
          <path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z" />
          <path d="m9 12 2 2 4-4" />
        </svg>
      );
    case "upload":
      return (
        <svg {...common}>
          <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
          <path d="m17 8-5-5-5 5M12 3v12" />
        </svg>
      );
    case "settings":
      return (
        <svg {...common}>
          <circle cx="12" cy="12" r="3" />
          <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 1 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06a1.65 1.65 0 0 0 .33-1.82 1.65 1.65 0 0 0-1.51-1H3a2 2 0 1 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06a1.65 1.65 0 0 0 1.82.33H9a1.65 1.65 0 0 0 1-1.51V3a2 2 0 1 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06a1.65 1.65 0 0 0-.33 1.82V9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 1 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z" />
        </svg>
      );
    case "key":
      return (
        <svg {...common}>
          <circle cx="7.5" cy="15.5" r="5.5" />
          <path d="m21 2-9.6 9.6M15.5 7.5l3 3L22 7l-3-3" />
        </svg>
      );
    case "search":
      return (
        <svg {...common}>
          <circle cx="11" cy="11" r="8" />
          <path d="m21 21-4.3-4.3" />
        </svg>
      );
    case "logout":
      return (
        <svg {...common}>
          <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4" />
          <path d="m16 17 5-5-5-5M21 12H9" />
        </svg>
      );
    default:
      return null;
  }
}

export function AppShell({ user, children }: { user: SessionUser | null; children: React.ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const [paletteOpen, setPaletteOpen] = useState(false);

  const logout = useCallback(async () => {
    await fetch("/api/auth/logout", { method: "POST" });
    router.replace("/login");
    router.refresh();
  }, [router]);

  useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null;
      const typing =
        target?.tagName === "INPUT" || target?.tagName === "TEXTAREA" || target?.isContentEditable;
      if (event.key === "/" && !typing) {
        event.preventDefault();
        setPaletteOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen(true);
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, []);

  if (!user) {
    return <main className="relative z-10 min-h-dvh">{children}</main>;
  }

  const items = NAV.filter((item) => (item.roles as readonly string[]).includes(user.role));

  return (
    <div className="relative z-10 flex min-h-dvh">
      <aside className="hidden w-60 shrink-0 flex-col border-r border-[var(--ub-border)] bg-[var(--ub-bg-elevated)] md:flex">
        <div className="flex h-16 items-center gap-2.5 px-5">
          <div className="flex h-8 w-8 items-center justify-center rounded-[8px] bg-[var(--ub-accent)] text-[#17130a]">
            <svg width="17" height="17" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" aria-hidden>
              <rect x="4" y="10" width="16" height="10" rx="2" />
              <path d="M8 10V7a4 4 0 0 1 8 0v3" />
            </svg>
          </div>
          <div className="leading-tight">
            <div className="text-[13px] font-semibold tracking-tight">Userbase</div>
            <div className="text-[10.5px] text-[var(--ub-text-dim)]">dostępy i sekrety</div>
          </div>
        </div>

        <nav className="flex-1 space-y-0.5 px-3 py-3">
          {items.map((item) => {
            const active = item.href === "/" ? pathname === "/" || pathname.startsWith("/pracownicy") : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-2.5 rounded-[var(--ub-radius-sm)] px-3 py-2 text-[13px] transition-colors ${
                  active
                    ? "bg-[var(--ub-accent-soft)] font-medium text-[var(--ub-accent-text)]"
                    : "text-[var(--ub-text-muted)] hover:bg-[var(--ub-bg-hover)] hover:text-[var(--ub-text)]"
                }`}
              >
                <Icon name={item.icon} size={16} />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="border-t border-[var(--ub-border)] p-3">
          <button
            type="button"
            onClick={() => setPaletteOpen(true)}
            className="mb-2 flex w-full items-center gap-2 rounded-[var(--ub-radius-sm)] border border-[var(--ub-border)] bg-[var(--ub-bg-input)] px-2.5 py-1.5 text-[12px] text-[var(--ub-text-dim)] transition-colors hover:border-[var(--ub-border-strong)] hover:text-[var(--ub-text-muted)]"
          >
            <Icon name="search" size={13} />
            <span className="flex-1 text-left">Szukaj…</span>
            <kbd className="rounded border border-[var(--ub-border-strong)] bg-[var(--ub-bg-panel)] px-1 py-px text-[10px]">/</kbd>
          </button>

          <div className="flex items-center gap-2 rounded-[var(--ub-radius-sm)] px-1 py-1">
            <div className="flex h-7 w-7 items-center justify-center rounded-full border border-[var(--ub-border-strong)] bg-[var(--ub-bg-hover)] text-[11px] font-semibold text-[var(--ub-text-muted)]">
              {user.displayName.slice(0, 2).toUpperCase()}
            </div>
            <div className="min-w-0 flex-1 leading-tight">
              <div className="truncate text-[12px] font-medium">{user.displayName}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--ub-text-dim)]">{user.role}</div>
            </div>
            <ThemeToggle />
            <button
              type="button"
              onClick={logout}
              title="Wyloguj"
              className="rounded p-1.5 text-[var(--ub-text-dim)] transition-colors hover:bg-[var(--ub-bg-hover)] hover:text-[var(--ub-danger)]"
            >
              <Icon name="logout" size={15} />
            </button>
          </div>
        </div>
      </aside>

      {/* Nawigacja mobilna */}
      <div className="fixed inset-x-0 bottom-0 z-30 flex border-t border-[var(--ub-border)] bg-[var(--ub-bg-elevated)] md:hidden">
        {items.map((item) => {
          const active = item.href === "/" ? pathname === "/" : pathname.startsWith(item.href);
          return (
            <Link
              key={item.href}
              href={item.href}
              className={`flex flex-1 flex-col items-center gap-0.5 py-2 text-[10px] ${
                active ? "text-[var(--ub-accent-text)]" : "text-[var(--ub-text-dim)]"
              }`}
            >
              <Icon name={item.icon} size={17} />
              {item.label}
            </Link>
          );
        })}
      </div>

      <main className="min-w-0 flex-1 pb-16 md:pb-0">{children}</main>

      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} role={user.role} />
      <ToastHost />
    </div>
  );
}

export { Icon };
