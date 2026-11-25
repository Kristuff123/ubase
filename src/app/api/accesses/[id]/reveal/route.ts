/**
 * POST /api/accesses/:id/reveal — podejrzenie sekretu.
 * Wymaga: rola admin/operator, CSRF, świeże potwierdzenie hasła (/api/auth/reauth),
 * rate limit. Każde podejrzenie trafia do logu audytowego.
 */
import { NextResponse } from "next/server";
import { canReveal, requireUser } from "@/lib/auth/context";
import { LIMITS, rateLimit } from "@/lib/auth/rate-limit";
import { hasFreshReauth } from "@/lib/auth/session";
import { revealSecret } from "@/lib/domain/workers";
import { handleApiError, readJson } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function POST(request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const ctx = await requireUser({ write: true });
    if (!canReveal(ctx.user.role)) {
      return NextResponse.json({ error: "Rola nie pozwala na podejrzenie sekretu", code: "forbidden" }, { status: 403 });
    }
    const limit = rateLimit(`reveal:${ctx.user.id}`, LIMITS.reveal.limit, LIMITS.reveal.windowMs);
    if (!limit.allowed) {
      return NextResponse.json(
        { error: `Zbyt wiele podejrzeń. Spróbuj za ${limit.retryAfterSeconds} s.`, code: "rate_limited" },
        { status: 429 },
      );
    }

    const body = await readJson<{ fieldKey?: string }>(request);
    if (!body.fieldKey) {
      return NextResponse.json({ error: "Brak pola", code: "validation" }, { status: 400 });
    }
    // Bramka serwerowa: hasło musi być potwierdzone w tej sesji w ostatnich 5 minutach.
    if (!hasFreshReauth(ctx.session)) {
      return NextResponse.json(
        { error: "Wymagane ponowne potwierdzenie hasła", code: "reauth_required" },
        { status: 403 },
      );
    }

    const { id } = await params;
    const result = revealSecret(ctx.db, {
      accessId: Number(id),
      fieldKey: body.fieldKey,
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
    });

    return NextResponse.json({ values: result.values, expiresInSeconds: 30 });
  } catch (error) {
    return handleApiError(error);
  }
}
