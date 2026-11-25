"use client";

/**
 * Minimalny system powiadomień (bez zależności).
 * `toast("...")` można wywołać z dowolnego komponentu klienckiego.
 */
import { useEffect, useState } from "react";

type Kind = "ok" | "error" | "info";
type Item = { id: number; message: string; kind: Kind };

const EVENT = "ub-toast";
let counter = 0;

export function toast(message: string, kind: Kind = "ok"): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent<Item>(EVENT, { detail: { id: ++counter, message, kind } }));
}

export function ToastHost() {
  const [items, setItems] = useState<Item[]>([]);

  useEffect(() => {
    const handler = (event: Event) => {
      const detail = (event as CustomEvent<Item>).detail;
      setItems((current) => [...current.slice(-3), detail]);
      setTimeout(() => {
        setItems((current) => current.filter((item) => item.id !== detail.id));
      }, detail.kind === "error" ? 6000 : 3500);
    };
    window.addEventListener(EVENT, handler);
    return () => window.removeEventListener(EVENT, handler);
  }, []);

  if (items.length === 0) return null;

  return (
    <div className="pointer-events-none fixed bottom-4 right-4 z-[60] flex w-full max-w-xs flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          role="status"
          className={`ub-slide-in pointer-events-auto flex items-start gap-2.5 rounded-[var(--ub-radius)] border px-3.5 py-2.5 text-[12.5px] shadow-[var(--ub-shadow-md)] ${
            item.kind === "ok"
              ? "border-[rgba(62,207,142,0.35)] bg-[#10241c] text-[var(--ub-ok)]"
              : item.kind === "error"
                ? "border-[rgba(242,85,90,0.35)] bg-[#2a1416] text-[var(--ub-danger)]"
                : "border-[var(--ub-border-strong)] bg-[var(--ub-bg-elevated)] text-[var(--ub-text)]"
          }`}
        >
          <span className="mt-[1px] shrink-0 text-[13px] leading-none">
            {item.kind === "ok" ? "✓" : item.kind === "error" ? "!" : "i"}
          </span>
          <span className="leading-snug">{item.message}</span>
        </div>
      ))}
    </div>
  );
}
