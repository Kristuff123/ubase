/** Normalizacja tekstu do wyszukiwania: polskie znaki → ascii, małe litery, pojedyncze spacje. */
export function foldDiacritics(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/ł/g, "l")
    .replace(/Ł/g, "L")
    .toLowerCase()
    .replace(/[^a-z0-9@._+-]+/g, " ")
    .trim()
    .replace(/\s+/g, " ");
}

export function formatDateTime(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("pl-PL", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "Europe/Warsaw",
  }).format(new Date(ts));
}

export function formatDate(ts: number | null | undefined): string {
  if (!ts) return "—";
  return new Intl.DateTimeFormat("pl-PL", { dateStyle: "medium", timeZone: "Europe/Warsaw" }).format(new Date(ts));
}

export function isoToDateInput(value: string | null | undefined): string {
  if (!value) return "";
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

/** Data z inputa (YYYY-MM-DD) jako początek dnia w UTC — spójne sortowanie. */
export function dateInputToTs(value: string): number | null {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const ts = Date.parse(`${value}T00:00:00Z`);
  return Number.isNaN(ts) ? null : ts;
}

export function pluralizePl(count: number, one: string, few: string, many: string): string {
  const mod10 = count % 10;
  const mod100 = count % 100;
  if (count === 1) return one;
  if (mod10 >= 2 && mod10 <= 4 && !(mod100 >= 12 && mod100 <= 14)) return few;
  return many;
}
