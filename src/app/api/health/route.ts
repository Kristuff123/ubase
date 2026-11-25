/** GET /api/health — healthcheck dla Dockera i monitoringu (bez autoryzacji). */
import { NextResponse } from "next/server";
import { getDb } from "@/db";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const db = getDb();
    const check = db.prepare("SELECT 1 AS ok").get() as { ok: number };
    const version = db.pragma("user_version", { simple: true });
    const keys = (
      db.prepare("SELECT COUNT(*) AS c FROM crypto_keys WHERE retired_at IS NULL").get() as { c: number }
    ).c;
    if (check.ok !== 1 || keys < 1) {
      return NextResponse.json({ status: "degraded", db: check.ok === 1, keys }, { status: 503 });
    }
    return NextResponse.json({ status: "ok", db: true, schemaVersion: Number(version), keys });
  } catch (error) {
    console.error("[health]", error);
    return NextResponse.json({ status: "error" }, { status: 503 });
  }
}
