/** Jednolite odpowiedzi API i mapowanie błędów na kody HTTP. */
import { NextResponse } from "next/server";
import { HttpError } from "./auth/context";
import { AuthError } from "./auth/service";

export function ok<T>(data: T, init?: ResponseInit): NextResponse {
  return NextResponse.json(data, init);
}

export function fail(status: number, message: string, code = "error"): NextResponse {
  return NextResponse.json({ error: message, code }, { status });
}

export function handleApiError(error: unknown): NextResponse {
  if (error instanceof HttpError) {
    return fail(error.status, error.message, error.code);
  }
  if (error instanceof AuthError) {
    const status =
      error.code === "rate_limited" || error.code === "locked" ? 429 : error.code === "invalid_code" ? 401 : 401;
    return fail(status, error.message, error.code);
  }
  if (error instanceof Error) {
    // Błędy walidacji domenowej — komunikat pokazujemy użytkownikowi.
    const message = error.message;
    const isValidation =
      /wymagane|Nieprawidłow|Niedozwolona|już istnieje|nie istnieje|musi|Brak |Pole |Podaj|Dla kategorii/.test(message);
    if (isValidation) return fail(400, message, "validation");
    console.error("[api]", error);
    return fail(500, "Wystąpił błąd serwera", "internal");
  }
  console.error("[api] nieznany błąd", error);
  return fail(500, "Wystąpił błąd serwera", "internal");
}

export async function readJson<T>(request: Request): Promise<T> {
  try {
    return (await request.json()) as T;
  } catch {
    throw new HttpError(400, "Nieprawidłowy format żądania", "bad_json");
  }
}
