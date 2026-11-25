/**
 * Łańcuch hashy logu audytowego.
 *
 * entry_hash = SHA-256(prev_hash || kanoniczny JSON wpisu)
 * Kanoniczny JSON: klucze posortowane, bez białych znaków. Dzięki temu weryfikacja
 * jest deterministyczna i niezależna od kolejności kolumn w bazie.
 */
import { createHash } from "node:crypto";

export const GENESIS_HASH = "0".repeat(64);

export type AuditPayload = {
  seq: number;
  at: number;
  actorUserId: number | null;
  actorName: string | null;
  actorIp: string | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  summary: string;
  details: unknown;
};

export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === "object") {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) out[key] = sortKeys(obj[key]);
    return out;
  }
  return value;
}

export function computeEntryHash(prevHash: string, payload: AuditPayload): string {
  const canonical = canonicalJson({
    seq: payload.seq,
    at: payload.at,
    actorUserId: payload.actorUserId,
    actorName: payload.actorName,
    actorIp: payload.actorIp,
    action: payload.action,
    entityType: payload.entityType,
    entityId: payload.entityId,
    summary: payload.summary,
    details: payload.details ?? null,
  });
  return createHash("sha256").update(prevHash).update(canonical).digest("hex");
}

export type StoredAuditRow = {
  seq: number;
  at: number;
  actor_user_id: number | null;
  actor_name: string | null;
  actor_ip: string | null;
  action: string;
  entity_type: string | null;
  entity_id: number | null;
  summary: string;
  details_json: string | null;
  prev_hash: string;
  entry_hash: string;
};

export type ChainVerification = {
  valid: boolean;
  checked: number;
  brokenAt?: number;
  reason?: string;
};

/** Przelicza cały łańcuch i wskazuje pierwszy uszkodzony wpis. */
export function verifyChain(rows: StoredAuditRow[]): ChainVerification {
  let prev = GENESIS_HASH;
  for (const row of rows) {
    if (row.prev_hash !== prev) {
      return { valid: false, checked: rows.indexOf(row), brokenAt: row.seq, reason: "Niezgodny hash poprzedniego wpisu" };
    }
    const expected = computeEntryHash(prev, {
      seq: row.seq,
      at: row.at,
      actorUserId: row.actor_user_id,
      actorName: row.actor_name,
      actorIp: row.actor_ip,
      action: row.action,
      entityType: row.entity_type,
      entityId: row.entity_id,
      summary: row.summary,
      details: row.details_json ? JSON.parse(row.details_json) : null,
    });
    if (expected !== row.entry_hash) {
      return { valid: false, checked: rows.indexOf(row), brokenAt: row.seq, reason: "Niezgodny hash wpisu" };
    }
    prev = row.entry_hash;
  }
  return { valid: true, checked: rows.length };
}
