/** GET /api/generator — wygenerowane hasło (serwer, CSPRNG). */
import { NextResponse } from "next/server";
import { requireEdit, requireUser } from "@/lib/auth/context";
import { generatePassword } from "@/lib/crypto/password-gen";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET(request: Request) {
  try {
    const ctx = await requireUser();
    requireEdit(ctx);
    const url = new URL(request.url);
    const lengthParam = url.searchParams.get("length");
    const maxDigitsParam = url.searchParams.get("maxDigits");
    const strong = url.searchParams.get("strong") === "1";

    const result = generatePassword({
      length: lengthParam ? Number(lengthParam) : undefined,
      maxDigits: maxDigitsParam !== null ? Number(maxDigitsParam) : undefined,
      strong,
    });
    return NextResponse.json(result, { headers: { "Cache-Control": "no-store" } });
  } catch (error) {
    return handleApiError(error);
  }
}
