import { describe, expect, it } from "vitest";
import { contentDisposition } from "@/lib/http";

/**
 * Regresja: polskie znaki w nazwie pliku wywalały eksport RODO błędem 500.
 * Nagłówki HTTP są ByteString (0–255), a „Ż” to U+017B — konstrukcja nagłówka
 * rzucała TypeError. Test pinuje obie części kontraktu: ASCII `filename`
 * i procentowo zakodowany `filename*`.
 */
describe("contentDisposition", () => {
  it("nie zawiera znaków spoza ASCII w polu filename", () => {
    const header = contentDisposition("pracownik-Żółkiewska-Zofia.json");
    const asciiName = /filename="([^"]*)"/.exec(header)![1];
    for (const char of asciiName) {
      expect(char.charCodeAt(0)).toBeLessThanOrEqual(127);
    }
  });

  it("transliteruje polskie znaki w filename", () => {
    expect(contentDisposition("pracownik-Żółkiewska-Zofia.json")).toContain(
      'filename="pracownik-Zolkiewska-Zofia.json"',
    );
  });

  it("zachowuje oryginalną nazwę w filename* (UTF-8, RFC 5987)", () => {
    const header = contentDisposition("pracownik-Żółkiewska-Zofia.json");
    expect(header).toContain("filename*=UTF-8''");
    const encoded = header.split("filename*=UTF-8''")[1];
    expect(decodeURIComponent(encoded)).toBe("pracownik-Żółkiewska-Zofia.json");
  });

  it("cały nagłówek jest ByteString — można go wysłać", () => {
    const header = contentDisposition("Łódź-Ćwiczenie-Źdźbło.json");
    for (const char of header) {
      expect(char.charCodeAt(0)).toBeLessThanOrEqual(255);
    }
  });

  it("transliteruje same polskie znaki do ASCII", () => {
    expect(contentDisposition("ŻÓŁĆ")).toContain('filename="ZOLC"');
  });

  it("używa zapasowej nazwy, gdy po oczyszczeniu nic nie zostaje", () => {
    // Znaki spoza ASCII bez odpowiednika (np. emoji, cyrylica) są wycinane.
    expect(contentDisposition("📄🎉")).toContain('filename="plik"');
  });

  it("usuwa cudzysłowy — nie da się wstrzyknąć dodatkowego parametru", () => {
    const header = contentDisposition('plik"; filename="evil.json');
    // Cudzysłowy i backslashe wycinamy, żeby nagłówek miał dokładnie jeden parametr filename.
    expect(header.match(/filename="/g)?.length).toBe(1);
  });

  it("zamienia spacje na podkreślenia w wersji ASCII", () => {
    expect(contentDisposition("Jan Kowalski.json")).toContain('filename="Jan_Kowalski.json"');
  });
});
