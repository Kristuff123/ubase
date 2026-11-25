"use client";

/**
 * Klient HTTP dla komponentów: dokłada token CSRF z cookie i normalizuje błędy API.
 * CSRF double-submit: cookie ustawia serwer, nagłówek musi się zgadzać (session.csrf_hash).
 */

export class ApiError extends Error {
  code: string;
  status: number;
  payload: unknown;
  constructor(status: number, message: string, code: string, payload?: unknown) {
    super(message);
    this.status = status;
    this.code = code;
    this.payload = payload;
  }
}

function csrfToken(): string {
  if (typeof document === "undefined") return "";
  const match = document.cookie.match(/(?:^|;\s*)ub_csrf=([^;]+)/);
  return match ? decodeURIComponent(match[1]) : "";
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown; signal?: AbortSignal } = {},
): Promise<T> {
  const method = options.method ?? (options.body === undefined ? "GET" : "POST");
  const headers: Record<string, string> = { Accept: "application/json" };
  if (options.body !== undefined) headers["Content-Type"] = "application/json";
  if (method !== "GET" && method !== "HEAD") headers["X-CSRF-Token"] = csrfToken();

  const response = await fetch(path, {
    method,
    headers,
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
    signal: options.signal,
    credentials: "same-origin",
  });

  const text = await response.text();
  const data = text ? (JSON.parse(text) as Record<string, unknown>) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      typeof data.error === "string" ? data.error : `Błąd ${response.status}`,
      typeof data.code === "string" ? data.code : "error",
      data,
    );
  }
  return data as T;
}

/** Ponowne potwierdzenie hasła — otwiera 5-minutowe okno na podejrzenie sekretów. */
export async function confirmPassword(password: string): Promise<void> {
  await api("/api/auth/reauth", { body: { password } });
}

/** Kopiowanie do schowka z fallbackiem dla kontekstów bez Clipboard API. */
export async function copyToClipboard(value: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    /* przechodzimy do fallbacku */
  }
  try {
    const area = document.createElement("textarea");
    area.value = value;
    area.setAttribute("readonly", "");
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(area);
    return ok;
  } catch {
    return false;
  }
}
