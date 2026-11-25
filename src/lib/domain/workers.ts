/**
 * Pracownicy i ich dostępy — najważniejsza część domeny.
 *
 * Zasady:
 * - sekrety szyfrowane per pole (DEK, AAD wiążący rekord),
 * - historia zmian pól bez wartości sekretów (redakcja „[zmieniono]"),
 * - archiwizacja zamiast usuwania,
 * - każda mutacja w transakcji razem z wpisem audytowym.
 */
import type { Db } from "@/db";
import { appendAudit, recordFieldChange, type AuditActor } from "@/lib/audit/log";
import { accessFieldAad, decryptWithKey, encryptWithKey } from "@/lib/crypto/envelope";
import { getActiveKey, keyForVersion } from "@/db/keys";
import { foldDiacritics } from "@/lib/utils";
import {
  getCategoryById,
  listCategories,
  parseSchema,
} from "./org";
import type {
  Access,
  AccessFieldValue,
  AccessView,
  FieldSchema,
  Worker,
  WorkerDetail,
  WorkerListItem,
} from "./types";

const REDACTED = "[zmieniono]";

/**
 * Sentinel dla edycji: pole sekretne z tą wartością zachowuje dotychczasowy
 * szyfrogram (bez odszyfrowywania i ponownego szyfrowania).
 */
export const KEEP_SECRET = "__KEEP__";

export type WorkerInput = {
  firstName: string;
  lastName: string;
  position?: string | null;
  orgUnitId?: number | null;
  email?: string | null;
  phone?: string | null;
  notes?: string | null;
};

function buildSearchBlob(parts: (string | null | undefined)[]): string {
  return foldDiacritics(parts.filter(Boolean).join(" "));
}

function orgUnitOf(db: Db, id: number | null) {
  if (!id) return undefined;
  return db.prepare("SELECT id, name, type FROM org_units WHERE id = ?").get(id) as
    | { id: number; name: string; type: string }
    | undefined;
}

export function createWorker(db: Db, input: WorkerInput, actor: AuditActor): Worker {
  const firstName = input.firstName?.trim();
  const lastName = input.lastName?.trim();
  if (!firstName || !lastName) throw new Error("Imię i nazwisko są wymagane");

  const ts = Date.now();
  const unit = orgUnitOf(db, input.orgUnitId ?? null);
  const blob = buildSearchBlob([firstName, lastName, input.position, unit?.name, input.email, input.phone]);

  const tx = db.transaction(() => {
    const id = db
      .prepare(
        `INSERT INTO workers (first_name, last_name, position, org_unit_id, email, phone, notes, status, search_blob, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, 'aktywny', ?, ?, ?)`,
      )
      .run(
        firstName,
        lastName,
        input.position?.trim() || null,
        input.orgUnitId ?? null,
        input.email?.trim() || null,
        input.phone?.trim() || null,
        input.notes?.trim() || null,
        blob,
        ts,
        ts,
      ).lastInsertRowid as number;

    appendAudit(db, {
      action: "worker.created",
      actor,
      summary: `Dodano pracownika: ${firstName} ${lastName}`,
      entityType: "worker",
      entityId: id,
      details: { orgUnit: unit?.name ?? null, position: input.position ?? null },
    });
    return id;
  });

  const id = tx();
  return db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker;
}

/** Ostrzeżenie o duplikacie — nie blokuje zapisu. */
export function findDuplicateWorker(
  db: Db,
  params: { firstName: string; lastName: string; orgUnitId: number | null; excludeId?: number },
): Worker | undefined {
  return db
    .prepare(
      `SELECT * FROM workers
       WHERE first_name = ? COLLATE NOCASE AND last_name = ? COLLATE NOCASE
         AND COALESCE(org_unit_id, -1) = COALESCE(?, -1)
         AND id != ?
       LIMIT 1`,
    )
    .get(params.firstName.trim(), params.lastName.trim(), params.orgUnitId, params.excludeId ?? -1) as
    | Worker
    | undefined;
}

export function updateWorker(
  db: Db,
  id: number,
  input: Partial<WorkerInput>,
  actor: AuditActor,
): Worker {
  const current = db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker | undefined;
  if (!current) throw new Error("Pracownik nie istnieje");

  const next = {
    first_name: input.firstName?.trim() ?? current.first_name,
    last_name: input.lastName?.trim() ?? current.last_name,
    position: input.position !== undefined ? input.position?.trim() || null : current.position,
    org_unit_id: input.orgUnitId !== undefined ? input.orgUnitId : current.org_unit_id,
    email: input.email !== undefined ? input.email?.trim() || null : current.email,
    phone: input.phone !== undefined ? input.phone?.trim() || null : current.phone,
    notes: input.notes !== undefined ? input.notes?.trim() || null : current.notes,
  };

  const unit = orgUnitOf(db, next.org_unit_id);
  const blob = buildSearchBlob([
    next.first_name,
    next.last_name,
    next.position,
    unit?.name,
    next.email,
    next.phone,
  ]);

  const tx = db.transaction(() => {
    db.prepare(
      `UPDATE workers SET first_name = ?, last_name = ?, position = ?, org_unit_id = ?, email = ?, phone = ?,
         notes = ?, search_blob = ?, updated_at = ? WHERE id = ?`,
    ).run(
      next.first_name,
      next.last_name,
      next.position,
      next.org_unit_id,
      next.email,
      next.phone,
      next.notes,
      blob,
      Date.now(),
      id,
    );

    const labels: Record<string, string> = {
      first_name: "Imię",
      last_name: "Nazwisko",
      position: "Stanowisko",
      org_unit_id: "Jednostka",
      email: "E-mail",
      phone: "Telefon",
      notes: "Notatki",
    };
    for (const key of Object.keys(next) as (keyof typeof next)[]) {
      const before = current[key] as string | number | null;
      const after = next[key] as string | number | null;
      if (String(before ?? "") === String(after ?? "")) continue;
      recordFieldChange(db, {
        entityType: "worker",
        entityId: id,
        fieldKey: labels[key] ?? key,
        oldValue: key === "org_unit_id" ? orgUnitOf(db, before as number | null)?.name ?? null : (before as string | null),
        newValue: key === "org_unit_id" ? unit?.name ?? null : (after as string | null),
        actorUserId: actor.userId,
      });
    }

    appendAudit(db, {
      action: "worker.updated",
      actor,
      summary: `Zmieniono dane pracownika: ${next.first_name} ${next.last_name}`,
      entityType: "worker",
      entityId: id,
    });
  });
  tx();

  return db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker;
}

export function archiveWorker(db: Db, id: number, actor: AuditActor): void {
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker | undefined;
  if (!worker) throw new Error("Pracownik nie istnieje");
  const tx = db.transaction(() => {
    db.prepare("UPDATE workers SET status = 'zarchiwizowany', archived_at = ?, archived_by = ?, updated_at = ? WHERE id = ?").run(
      Date.now(),
      actor.userId,
      Date.now(),
      id,
    );
    appendAudit(db, {
      action: "worker.archived",
      actor,
      summary: `Zarchiwizowano pracownika: ${worker.first_name} ${worker.last_name}`,
      entityType: "worker",
      entityId: id,
    });
  });
  tx();
}

export function restoreWorker(db: Db, id: number, actor: AuditActor): void {
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(id) as Worker | undefined;
  if (!worker) throw new Error("Pracownik nie istnieje");
  const tx = db.transaction(() => {
    db.prepare("UPDATE workers SET status = 'aktywny', archived_at = NULL, archived_by = NULL, updated_at = ? WHERE id = ?").run(
      Date.now(),
      id,
    );
    appendAudit(db, {
      action: "worker.restored",
      actor,
      summary: `Przywrócono pracownika: ${worker.first_name} ${worker.last_name}`,
      entityType: "worker",
      entityId: id,
    });
  });
  tx();
}

/* ------------------------------------------------------------------ */
/* Dostępy                                                             */
/* ------------------------------------------------------------------ */

export type AccessInput = {
  categoryId: number;
  title?: string | null;
  resourceOwner?: "firma" | "pracownik";
  values: Record<string, string | string[]>;
};

/** Sprawdza wymagalność pól i normalizuje wartości do list. */
function validateValues(schema: FieldSchema, values: Record<string, string | string[]>): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const field of schema) {
    const raw = values[field.key];
    const list = Array.isArray(raw) ? raw : raw !== undefined && raw !== "" ? [raw] : [];
    if (field.required && list.length === 0) {
      throw new Error(`Pole „${field.label}" jest wymagane`);
    }
    if (field.type === "select" && list.length > 1) {
      throw new Error(`Pole „${field.label}" przyjmuje jedną wartość`);
    }
    if (field.type === "multiselect" && field.options) {
      for (const value of list) {
        if (!field.options.includes(value)) {
          throw new Error(`Niedozwolona wartość „${value}" w polu „${field.label}"`);
        }
      }
    }
    if (field.type !== "ref_org_unit" && list.length === 0) continue;
    out[field.key] = list.map((v) => String(v).trim()).filter(Boolean);
  }
  return out;
}

function insertFields(
  db: Db,
  params: { workerId: number; accessId: number; schema: FieldSchema; values: Record<string, string[]> },
): void {
  const { dek, version } = getActiveKey(db);
  const insert = db.prepare(
    "INSERT INTO access_fields (access_id, field_key, value_text, value_enc, key_version) VALUES (?, ?, ?, ?, ?)",
  );
  for (const field of params.schema) {
    const list = params.values[field.key] ?? [];
    for (const value of list) {
      if (!value) continue;
      const isSecret = Boolean(field.secret || field.type === "password");
      if (isSecret) {
        insert.run(
          params.accessId,
          field.key,
          null,
          encryptWithKey(value, dek, accessFieldAad(params.workerId, params.accessId, field.key)),
          version,
        );
      } else {
        insert.run(params.accessId, field.key, value, null, null);
      }
    }
  }
}

/** Wartości pól dostępu — sekrety zamaskowane, tylko informacja „ustawione". */
function readFields(db: Db, accessId: number, schema: FieldSchema): AccessFieldValue[] {
  const rows = db
    .prepare("SELECT field_key, value_text, value_enc FROM access_fields WHERE access_id = ? ORDER BY id")
    .all(accessId) as { field_key: string; value_text: string | null; value_enc: string | null }[];

  const byKey = new Map<string, { values: string[]; hasValue: boolean }>();
  for (const row of rows) {
    const field = schema.find((f) => f.key === row.field_key);
    const isSecret = Boolean(field?.secret || field?.type === "password");
    const entry = byKey.get(row.field_key) ?? { values: [], hasValue: false };
    if (isSecret) {
      entry.hasValue = true;
      const hidden = row.value_enc ? "••••••••" : "";
      if (hidden) entry.values.push(hidden);
    } else if (row.value_text !== null) {
      entry.values.push(row.value_text);
      entry.hasValue = true;
    }
    byKey.set(row.field_key, entry);
  }

  const known = new Set(schema.map((f) => f.key));
  const result: AccessFieldValue[] = schema.map((field) => {
    const entry = byKey.get(field.key) ?? { values: [], hasValue: false };
    return {
      key: field.key,
      label: field.label,
      type: field.type,
      secret: Boolean(field.secret || field.type === "password"),
      values: entry.values,
      hasValue: entry.hasValue,
      unitType: field.unitType,
    };
  });

  // Pola spoza schematu (np. po zmianie definicji kategorii) — pokazujemy surowo.
  for (const [key, entry] of byKey) {
    if (known.has(key)) continue;
    const secret = rows.some((r) => r.field_key === key && r.value_enc);
    result.push({
      key,
      label: key,
      type: secret ? "password" : "text",
      secret,
      values: secret ? ["••••••••"] : entry.values,
      hasValue: entry.hasValue,
    });
  }
  return result;
}

export function addAccess(
  db: Db,
  workerId: number,
  input: AccessInput,
  actor: AuditActor,
): number {
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(workerId) as Worker | undefined;
  if (!worker) throw new Error("Pracownik nie istnieje");
  const category = getCategoryById(db, input.categoryId);
  if (!category) throw new Error("Kategoria dostępu nie istnieje");

  const schema = parseSchema(category);
  const isOther = category.slug === "inne";
  const values = validateValues(schema, input.values);

  if (isOther) {
    const title = input.title?.trim();
    if (!title) throw new Error('Dla kategorii „inne” podaj nazwę dostępu');
  }

  const tx = db.transaction(() => {
    const ts = Date.now();
    const accessId = db
      .prepare(
        `INSERT INTO accesses (worker_id, category_id, title, status, resource_owner, created_at, updated_at, created_by)
         VALUES (?, ?, ?, 'aktywny', ?, ?, ?, ?)`,
      )
      .run(
        workerId,
        category.id,
        input.title?.trim() || null,
        input.resourceOwner ?? "firma",
        ts,
        ts,
        actor.userId,
      ).lastInsertRowid as number;

    insertFields(db, { workerId, accessId, schema, values });

    const descriptor = input.title?.trim() || category.name;
    appendAudit(db, {
      action: "access.created",
      actor,
      summary: `Dodano dostęp „${descriptor}" dla ${worker.first_name} ${worker.last_name}`,
      entityType: "worker",
      entityId: workerId,
      details: { accessId, category: category.slug },
    });
    db.prepare("UPDATE workers SET updated_at = ? WHERE id = ?").run(ts, workerId);
    return accessId;
  });

  return tx();
}

export function updateAccess(
  db: Db,
  accessId: number,
  input: AccessInput,
  actor: AuditActor,
): void {
  const access = db.prepare("SELECT * FROM accesses WHERE id = ?").get(accessId) as Access | undefined;
  if (!access) throw new Error("Dostęp nie istnieje");
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(access.worker_id) as Worker;
  const category = getCategoryById(db, input.categoryId ?? access.category_id);
  if (!category) throw new Error("Kategoria dostępu nie istnieje");
  const schema = parseSchema(category);
  const values = validateValues(schema, input.values);

  // Pola sekretne z sentinelem zachowują stary szyfrogram — wyciągamy je przed walidacją zapisu.
  const keptKeys = new Set(
    schema.filter((f) => (f.secret || f.type === "password") && (input.values[f.key] as string) === KEEP_SECRET).map((f) => f.key),
  );
  for (const key of keptKeys) delete values[key];

  const tx = db.transaction(() => {
    const ts = Date.now();
    db.prepare("UPDATE accesses SET title = ?, resource_owner = ?, updated_at = ? WHERE id = ?").run(
      input.title !== undefined ? input.title?.trim() || null : access.title,
      input.resourceOwner ?? access.resource_owner,
      ts,
      accessId,
    );

    // Historia: które pola się zmieniły (bez wartości sekretów).
    // Dla sekretów porównujemy odszyfrowane wartości, ale do historii trafia tylko znacznik.
    const previous = db
      .prepare("SELECT field_key, value_text, value_enc, key_version FROM access_fields WHERE access_id = ? ORDER BY id")
      .all(accessId) as {
      field_key: string;
      value_text: string | null;
      value_enc: string | null;
      key_version: number | null;
    }[];

    const decryptPrevious = (row: (typeof previous)[number]): string => {
      if (!row.value_enc) return row.value_text ?? "";
      const key = keyForVersion(db, row.key_version ?? 1);
      return decryptWithKey(row.value_enc, key, accessFieldAad(access.worker_id, accessId, row.field_key));
    };

    db.prepare("DELETE FROM access_fields WHERE access_id = ?").run(accessId);
    insertFields(db, { workerId: access.worker_id, accessId, schema, values });
    // Zachowane sekrety wracają w niezmienionej postaci (ten sam szyfrogram, ten sam klucz).
    const restore = db.prepare(
      "INSERT INTO access_fields (access_id, field_key, value_text, value_enc, key_version) VALUES (?, ?, ?, ?, ?)",
    );
    for (const row of previous) {
      if (!keptKeys.has(row.field_key)) continue;
      restore.run(accessId, row.field_key, row.value_text, row.value_enc, row.key_version);
    }

    const touched = new Set<string>([...previous.map((p) => p.field_key), ...Object.keys(values)]);
    for (const key of touched) {
      if (keptKeys.has(key)) continue;
      const field = schema.find((f) => f.key === key);
      const isSecret = Boolean(field?.secret || field?.type === "password");
      const beforeRows = previous.filter((p) => p.field_key === key);
      const after = values[key] ?? [];

      if (isSecret) {
        const beforePlain = beforeRows.map(decryptPrevious).join("\n");
        const afterPlain = after.join("\n");
        if (beforePlain === afterPlain) continue;
        recordFieldChange(db, {
          entityType: "access",
          entityId: accessId,
          fieldKey: field?.label ?? key,
          oldValue: beforePlain ? REDACTED : null,
          newValue: afterPlain ? REDACTED : null,
          actorUserId: actor.userId,
        });
        continue;
      }

      const beforeText = beforeRows
        .map((p) => p.value_text ?? "")
        .filter(Boolean)
        .join(", ");
      const afterText = after.join(", ");
      if (beforeText === afterText) continue;
      recordFieldChange(db, {
        entityType: "access",
        entityId: accessId,
        fieldKey: field?.label ?? key,
        oldValue: beforeText || null,
        newValue: afterText || null,
        actorUserId: actor.userId,
      });
    }

    appendAudit(db, {
      action: "access.updated",
      actor,
      summary: `Zmieniono dostęp „${input.title?.trim() || category.name}" u ${worker.first_name} ${worker.last_name}`,
      entityType: "worker",
      entityId: access.worker_id,
      details: { accessId, category: category.slug },
    });
    db.prepare("UPDATE workers SET updated_at = ? WHERE id = ?").run(ts, access.worker_id);
  });
  tx();
}

export function revokeAccess(db: Db, accessId: number, actor: AuditActor): void {
  const access = db.prepare("SELECT * FROM accesses WHERE id = ?").get(accessId) as Access | undefined;
  if (!access) throw new Error("Dostęp nie istnieje");
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(access.worker_id) as Worker;
  const category = getCategoryById(db, access.category_id);

  const tx = db.transaction(() => {
    db.prepare(
      "UPDATE accesses SET status = 'wycofany', revoked_at = ?, revoked_by = ?, updated_at = ? WHERE id = ?",
    ).run(Date.now(), actor.userId, Date.now(), accessId);
    appendAudit(db, {
      action: "access.revoked",
      actor,
      summary: `Wycofano dostęp „${access.title || category?.name || access.category_id}" u ${worker.first_name} ${worker.last_name}`,
      entityType: "worker",
      entityId: access.worker_id,
      details: { accessId },
    });
  });
  tx();
}

/** Odszyfrowanie pojedynczego sekretu — tylko dla ról z prawem reveal. */
export function revealSecret(
  db: Db,
  params: { accessId: number; fieldKey: string; actor: AuditActor },
): { values: string[] } {
  const access = db.prepare("SELECT * FROM accesses WHERE id = ?").get(params.accessId) as Access | undefined;
  if (!access) throw new Error("Dostęp nie istnieje");
  const worker = db.prepare("SELECT * FROM workers WHERE id = ?").get(access.worker_id) as Worker;

  const rows = db
    .prepare("SELECT value_text, value_enc, key_version FROM access_fields WHERE access_id = ? AND field_key = ? ORDER BY id")
    .all(params.accessId, params.fieldKey) as {
    value_text: string | null;
    value_enc: string | null;
    key_version: number | null;
  }[];
  if (rows.length === 0) throw new Error("Pole nie ma wartości");

  const values = rows.map((row) => {
    if (row.value_enc) {
      const key = keyForVersion(db, row.key_version ?? 1);
      return decryptWithKey(row.value_enc, key, accessFieldAad(access.worker_id, params.accessId, params.fieldKey));
    }
    return row.value_text ?? "";
  });

  appendAudit(db, {
    action: "secret.revealed",
    actor: params.actor,
    summary: `Podejrzano sekret „${params.fieldKey}" (${access.title || "dostęp"}) u ${worker.first_name} ${worker.last_name}`,
    entityType: "worker",
    entityId: access.worker_id,
    details: { accessId: params.accessId, field: params.fieldKey },
  });

  return { values };
}

/** Lista pracowników z licznikami dostępów. */
export function listWorkers(
  db: Db,
  options: { q?: string; status?: "aktywny" | "zarchiwizowany" | "wszyscy"; categorySlug?: string; limit?: number; offset?: number } = {},
): { items: WorkerListItem[]; total: number } {
  const clauses: string[] = [];
  const params: unknown[] = [];

  if (!options.status || options.status === "aktywny") {
    clauses.push("w.status = 'aktywny'");
  } else if (options.status === "zarchiwizowany") {
    clauses.push("w.status = 'zarchiwizowany'");
  }

  const q = options.q?.trim();
  if (q) {
    const folded = foldDiacritics(q);
    clauses.push("(w.search_blob LIKE ? OR EXISTS (SELECT 1 FROM accesses a JOIN access_fields f ON f.access_id = a.id WHERE a.worker_id = w.id AND f.value_text LIKE ?))");
    params.push(`%${folded}%`, `%${q}%`);
  }

  if (options.categorySlug) {
    clauses.push(
      "EXISTS (SELECT 1 FROM accesses a JOIN access_categories c ON c.id = a.category_id WHERE a.worker_id = w.id AND c.slug = ? AND a.status = 'aktywny')",
    );
    params.push(options.categorySlug);
  }

  const where = clauses.length ? `WHERE ${clauses.join(" AND ")}` : "";
  const limit = Math.min(options.limit ?? 50, 200);
  const offset = options.offset ?? 0;

  const total = (db.prepare(`SELECT COUNT(*) AS c FROM workers w ${where}`).get(...params) as { c: number }).c;

  const rows = db
    .prepare(
      `SELECT w.*, o.name AS org_unit_name, o.type AS org_unit_type,
              (SELECT COUNT(*) FROM accesses a WHERE a.worker_id = w.id AND a.status = 'aktywny') AS access_count
       FROM workers w
       LEFT JOIN org_units o ON o.id = w.org_unit_id
       ${where}
       ORDER BY w.status = 'zarchiwizowany', w.last_name COLLATE NOCASE, w.first_name COLLATE NOCASE
       LIMIT ? OFFSET ?`,
    )
    .all(...params, limit, offset) as (Worker & {
    org_unit_name: string | null;
    org_unit_type: string | null;
    access_count: number;
  })[];

  const catStmt = db.prepare(
    `SELECT c.slug, c.name, COUNT(*) AS count
     FROM accesses a JOIN access_categories c ON c.id = a.category_id
     WHERE a.worker_id = ? AND a.status = 'aktywny'
     GROUP BY c.slug, c.name ORDER BY c.sort_order`,
  );

  const items = rows.map((row) => ({
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    position: row.position,
    orgUnitName: row.org_unit_name,
    orgUnitType: row.org_unit_type,
    status: row.status,
    email: row.email,
    accessCount: row.access_count,
    categories: catStmt.all(row.id) as { slug: string; name: string; count: number }[],
    updatedAt: row.updated_at,
  }));

  return { items, total };
}

export function getWorkerDetail(db: Db, id: number): WorkerDetail | null {
  const row = db
    .prepare(
      `SELECT w.*, o.name AS org_unit_name, o.type AS org_unit_type,
              (SELECT COUNT(*) FROM accesses a WHERE a.worker_id = w.id AND a.status = 'aktywny') AS access_count
       FROM workers w LEFT JOIN org_units o ON o.id = w.org_unit_id
       WHERE w.id = ?`,
    )
    .get(id) as
    | (Worker & { org_unit_name: string | null; org_unit_type: string | null; access_count: number })
    | undefined;
  if (!row) return null;

  const categories = listCategories(db);
  const accessRows = db
    .prepare("SELECT * FROM accesses WHERE worker_id = ? ORDER BY status = 'wycofany', created_at DESC")
    .all(id) as Access[];

  const accesses: AccessView[] = accessRows.map((access) => {
    const category = categories.find((c) => c.id === access.category_id);
    const schema = category ? parseSchema(category) : [];
    const fields = readFields(db, access.id, schema);
    return {
      id: access.id,
      categorySlug: category?.slug ?? "unknown",
      categoryName: category?.name ?? "Nieznana",
      categoryIcon: category?.icon ?? null,
      title: access.title,
      status: access.status,
      resourceOwner: access.resource_owner,
      createdAt: access.created_at,
      updatedAt: access.updated_at,
      revokedAt: access.revoked_at,
      createdBy: access.created_by,
      fields,
      secretsCount: fields.filter((f) => f.secret && f.hasValue).length,
    };
  });

  return {
    id: row.id,
    firstName: row.first_name,
    lastName: row.last_name,
    position: row.position,
    orgUnitName: row.org_unit_name,
    orgUnitType: row.org_unit_type,
    status: row.status,
    email: row.email,
    phone: row.phone,
    notes: row.notes,
    accessCount: row.access_count,
    categories: [],
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    archivedAt: row.archived_at,
    accesses,
  };
}

/** Eksport RODO — dane pracownika bez sekretów (domyślnie). */
export function exportWorkerData(
  db: Db,
  id: number,
  options: { includeSecrets: boolean; actor: AuditActor },
): Record<string, unknown> {
  const detail = getWorkerDetail(db, id);
  if (!detail) throw new Error("Pracownik nie istnieje");

  const accesses = detail.accesses.map((access) => ({
    kategoria: access.categoryName,
    nazwa: access.title,
    status: access.status,
    zasob: access.resourceOwner,
    utworzono: access.createdAt,
    pola: access.fields.map((field) => ({
      pole: field.label,
      wartosc:
        field.secret && !options.includeSecrets
          ? "[pominięto]"
          : field.type === "ref_org_unit"
            ? field.values.map((value) => {
                const unit = db.prepare("SELECT name FROM org_units WHERE id = ?").get(Number(value)) as
                  | { name: string }
                  | undefined;
                return unit?.name ?? value;
              })
            : field.values,
    })),
  }));

  appendAudit(db, {
    action: "worker.exported",
    actor: options.actor,
    summary: `Wyeksportowano dane pracownika: ${detail.firstName} ${detail.lastName}${options.includeSecrets ? " (z sekretami)" : ""}`,
    entityType: "worker",
    entityId: id,
    details: { includeSecrets: options.includeSecrets },
  });

  return {
    imie: detail.firstName,
    nazwisko: detail.lastName,
    stanowisko: detail.position,
    jednostka: detail.orgUnitName,
    email: detail.email,
    telefon: detail.phone,
    notatki: detail.notes,
    status: detail.status,
    dostepy: accesses,
  };
}

