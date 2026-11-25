/**
 * Zapis zdarzeń audytowych — tylko dopisywanie, z łańcuchem hashy.
 *
 * Każdy wpis jest liczony na podstawie hasha poprzedniego, więc podmiana lub usunięcie
 * wpisu w środku łańcucha jest wykrywalne przez /api/audit/verify.
 */
import type { Db } from "@/db";
import { computeEntryHash, GENESIS_HASH, verifyChain, type StoredAuditRow } from "./chain";

export type AuditActor = {
  userId: number | null;
  name: string | null;
  ip: string | null;
};

export type AuditAction =
  | "auth.login"
  | "auth.login_failed"
  | "auth.2fa"
  | "auth.2fa_failed"
  | "auth.logout"
  | "auth.reauth"
  | "auth.reauth_failed"
  | "auth.lockout"
  | "auth.password_changed"
  | "auth.totp_enrolled"
  | "auth.totp_reset"
  | "auth.recovery_codes_viewed"
  | "user.created"
  | "user.updated"
  | "user.deactivated"
  | "worker.created"
  | "worker.updated"
  | "worker.archived"
  | "worker.restored"
  | "worker.purged"
  | "access.created"
  | "access.updated"
  | "access.revoked"
  | "secret.revealed"
  | "secret.copied"
  | "import.previewed"
  | "import.committed"
  | "audit.verified"
  | "audit.exported"
  | "admin.org_unit.created"
  | "admin.org_unit.updated"
  | "admin.category.created"
  | "admin.category.updated"
  | "backup.created"
  | "key.rotated"
  | "worker.exported";

export type AuditInput = {
  action: AuditAction;
  actor: AuditActor;
  summary: string;
  entityType?: string | null;
  entityId?: number | null;
  details?: unknown;
};

/**
 * Dopisuje zdarzenie. Musi być wywoływane wewnątrz transakcji wywołującego, jeśli
 * ma być atomowe ze zmianą danych.
 */
export function appendAudit(db: Db, input: AuditInput): number {
  const last = db
    .prepare("SELECT seq, entry_hash FROM audit_events ORDER BY seq DESC LIMIT 1")
    .get() as { seq: number; entry_hash: string } | undefined;
  const prevHash = last?.entry_hash ?? GENESIS_HASH;
  const seq = (last?.seq ?? 0) + 1;
  const at = Date.now();

  const details = input.details ?? null;
  const hash = computeEntryHash(prevHash, {
    seq,
    at,
    actorUserId: input.actor.userId,
    actorName: input.actor.name,
    actorIp: input.actor.ip,
    action: input.action,
    entityType: input.entityType ?? null,
    entityId: input.entityId ?? null,
    summary: input.summary,
    details,
  });

  db.prepare(
    `INSERT INTO audit_events
       (seq, at, actor_user_id, actor_name, actor_ip, action, entity_type, entity_id,
        summary, details_json, prev_hash, entry_hash)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    seq,
    at,
    input.actor.userId,
    input.actor.name,
    input.actor.ip,
    input.action,
    input.entityType ?? null,
    input.entityId ?? null,
    input.summary,
    details === null ? null : JSON.stringify(details),
    prevHash,
    hash,
  );

  return seq;
}

export function readAuditRange(
  db: Db,
  filter: { from?: number; to?: number; actorId?: number; action?: string; entityType?: string; entityId?: number; limit?: number; offset?: number } = {},
): StoredAuditRow[] {
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.from) {
    clauses.push("at >= ?");
    params.push(filter.from);
  }
  if (filter.to) {
    clauses.push("at <= ?");
    params.push(filter.to);
  }
  if (filter.actorId) {
    clauses.push("actor_user_id = ?");
    params.push(filter.actorId);
  }
  if (filter.action) {
    clauses.push("action = ?");
    params.push(filter.action);
  }
  if (filter.entityType) {
    clauses.push("entity_type = ?");
    params.push(filter.entityType);
  }
  if (filter.entityId) {
    clauses.push("entity_id = ?");
    params.push(filter.entityId);
  }
  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(filter.limit ?? 100, 1000);
  const offset = filter.offset ?? 0;
  return db
    .prepare(`SELECT * FROM audit_events ${where} ORDER BY seq DESC LIMIT ? OFFSET ?`)
    .all(...params, limit, offset) as StoredAuditRow[];
}

export function verifyAuditChain(db: Db) {
  const rows = db.prepare("SELECT * FROM audit_events ORDER BY seq ASC").all() as StoredAuditRow[];
  return verifyChain(rows);
}

/** Historia zmian pól rekordu (bez wartości sekretów — redagowane przez wołającego). */
export function recordFieldChange(
  db: Db,
  params: {
    entityType: string;
    entityId: number;
    fieldKey: string;
    oldValue: string | null;
    newValue: string | null;
    actorUserId: number | null;
    at?: number;
  },
): void {
  db.prepare(
    `INSERT INTO record_history (entity_type, entity_id, field_key, old_value, new_value, actor_user_id, changed_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    params.entityType,
    params.entityId,
    params.fieldKey,
    params.oldValue,
    params.newValue,
    params.actorUserId,
    params.at ?? Date.now(),
  );
}

export function readHistory(db: Db, entityType: string, entityId: number, limit = 200) {
  return db
    .prepare(
      `SELECT h.*, u.display_name AS actor_name
       FROM record_history h
       LEFT JOIN app_users u ON u.id = h.actor_user_id
       WHERE h.entity_type = ? AND h.entity_id = ?
       ORDER BY h.changed_at DESC, h.id DESC
       LIMIT ?`,
    )
    .all(entityType, entityId, limit) as {
    id: number;
    entity_type: string;
    entity_id: number;
    field_key: string;
    old_value: string | null;
    new_value: string | null;
    actor_user_id: number | null;
    actor_name: string | null;
    changed_at: number;
  }[];
}
