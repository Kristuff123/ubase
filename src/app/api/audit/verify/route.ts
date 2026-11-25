/** GET /api/audit/verify — przelicza łańcuch hashy i zwraca wynik. */
import { NextResponse } from "next/server";
import { requireUser } from "@/lib/auth/context";
import { appendAudit, verifyAuditChain } from "@/lib/audit/log";
import { handleApiError } from "@/lib/api";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const ctx = await requireUser();
    const result = verifyAuditChain(ctx.db);
    appendAudit(ctx.db, {
      action: "audit.verified",
      actor: { userId: ctx.user.id, name: ctx.user.display_name, ip: ctx.ip },
      summary: result.valid
        ? `Weryfikacja łańcucha audytu: poprawny (${result.checked} wpisów)`
        : `Weryfikacja łańcucha audytu: USZKODZONY na wpisie ${result.brokenAt}`,
      details: result,
    });
    return NextResponse.json(result);
  } catch (error) {
    return handleApiError(error);
  }
}
