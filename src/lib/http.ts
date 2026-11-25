/**
 * Helpery HTTP współdzielone przez route handlery.
 */

/**
 * Nagłówek `Content-Disposition` z nazwą pliku zawierającą polskie znaki.
 *
 * Nagłówki HTTP są ByteString — znak spoza 0–255 (np. „Ż” = U+017B) powoduje
 * `TypeError` i odpowiedź 500. Dlatego:
 *  - `filename` dostaje wersję ASCII (transliteracja + usunięcie reszty),
 *  - `filename*` (RFC 5987) niesie oryginał w UTF-8; przeglądarki preferują tę formę.
 *
 * Przykład: `pracownik-Żółkiewska-Zofia.json` →
 *   attachment; filename="pracownik-Zolkiewska-Zofia.json"; filename*=UTF-8''pracownik-%C5%BB%C3%B3%C5%82kiewska-Zofia.json
 */
export function contentDisposition(filename: string): string {
  const ascii =
    filename
      .normalize("NFKD")
      .replace(/[\u0300-\u036f]/g, "")
      .replace(/ł/g, "l")
      .replace(/Ł/g, "L")
      .replace(/[^\x20-\x7e]/g, "")
      .replace(/["\\]/g, "")
      .replace(/\s+/g, "_") || "plik";

  const encoded = encodeURIComponent(filename).replace(/['()*]/g, (char) =>
    `%${char.charCodeAt(0).toString(16).toUpperCase()}`,
  );

  return `attachment; filename="${ascii}"; filename*=UTF-8''${encoded}`;
}
