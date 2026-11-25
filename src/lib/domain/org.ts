/**
 * Jednostki organizacyjne i kategorie dostępów.
 * Regiony → sklepy (parent), zakłady i biura samodzielne.
 */
import type { Db } from "@/db";
import { appendAudit, type AuditActor } from "@/lib/audit/log";
import type { AccessCategory, FieldDef, FieldSchema, OrgUnit } from "./types";

export const UNIT_LABELS: Record<OrgUnit["type"], string> = {
  region: "Region",
  zaklad: "Zakład",
  sklep: "Sklep",
  biuro: "Biuro",
};

export function listOrgUnits(db: Db, type?: OrgUnit["type"]): OrgUnit[] {
  if (type) {
    return db
      .prepare("SELECT * FROM org_units WHERE type = ? ORDER BY name COLLATE NOCASE")
      .all(type) as OrgUnit[];
  }
  return db.prepare("SELECT * FROM org_units ORDER BY type, name COLLATE NOCASE").all() as OrgUnit[];
}

export function getOrgUnit(db: Db, id: number): OrgUnit | undefined {
  return db.prepare("SELECT * FROM org_units WHERE id = ?").get(id) as OrgUnit | undefined;
}

export function createOrgUnit(
  db: Db,
  params: { type: OrgUnit["type"]; name: string; number?: string | null; parentId?: number | null; actor: AuditActor },
): OrgUnit {
  const name = params.name.trim();
  if (!name) throw new Error("Nazwa jednostki jest wymagana");
  if (params.type === "sklep" && params.parentId) {
    const parent = getOrgUnit(db, params.parentId);
    if (!parent || parent.type !== "region") throw new Error("Rodzicem sklepu musi być region");
  }
  const existing = db
    .prepare("SELECT id FROM org_units WHERE type = ? AND name = ? COLLATE NOCASE")
    .get(params.type, name);
  if (existing) throw new Error(`Jednostka „${name}" już istnieje`);

  const id = db
    .prepare("INSERT INTO org_units (type, name, number, parent_id, created_at) VALUES (?, ?, ?, ?, ?)")
    .run(params.type, name, params.number ?? null, params.parentId ?? null, Date.now()).lastInsertRowid as number;

  appendAudit(db, {
    action: "admin.org_unit.created",
    actor: params.actor,
    summary: `Dodano jednostkę ${UNIT_LABELS[params.type]}: ${name}`,
    entityType: "org_unit",
    entityId: id,
  });
  return getOrgUnit(db, id)!;
}

export function updateOrgUnit(
  db: Db,
  id: number,
  params: { name?: string; number?: string | null; parentId?: number | null; isActive?: boolean; actor: AuditActor },
): OrgUnit {
  const current = getOrgUnit(db, id);
  if (!current) throw new Error("Jednostka nie istnieje");
  const name = params.name?.trim() ?? current.name;
  db.prepare("UPDATE org_units SET name = ?, number = ?, parent_id = ?, is_active = ? WHERE id = ?").run(
    name,
    params.number !== undefined ? params.number : current.number,
    params.parentId !== undefined ? params.parentId : current.parent_id,
    params.isActive === false ? 0 : 1,
    id,
  );
  appendAudit(db, {
    action: "admin.org_unit.updated",
    actor: params.actor,
    summary: `Zmieniono jednostkę: ${current.name} → ${name}`,
    entityType: "org_unit",
    entityId: id,
  });
  return getOrgUnit(db, id)!;
}

/** Kategorie dostępów z parsowanym schematem pól. */
export function listCategories(db: Db, options: { activeOnly?: boolean } = {}): AccessCategory[] {
  const where = options.activeOnly ? "WHERE is_active = 1" : "";
  return db
    .prepare(`SELECT * FROM access_categories ${where} ORDER BY sort_order, name`)
    .all() as AccessCategory[];
}

export function parseSchema(category: AccessCategory | string): FieldSchema {
  const raw = typeof category === "string" ? category : category.field_schema;
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as FieldDef[]) : [];
  } catch {
    return [];
  }
}

export function getCategoryBySlug(db: Db, slug: string): AccessCategory | undefined {
  return db.prepare("SELECT * FROM access_categories WHERE slug = ?").get(slug) as AccessCategory | undefined;
}

export function getCategoryById(db: Db, id: number): AccessCategory | undefined {
  return db.prepare("SELECT * FROM access_categories WHERE id = ?").get(id) as AccessCategory | undefined;
}

export function updateCategory(
  db: Db,
  id: number,
  params: { name?: string; sortOrder?: number; isActive?: boolean; actor: AuditActor },
): AccessCategory {
  const current = getCategoryById(db, id);
  if (!current) throw new Error("Kategoria nie istnieje");
  db.prepare("UPDATE access_categories SET name = ?, sort_order = ?, is_active = ? WHERE id = ?").run(
    params.name?.trim() || current.name,
    params.sortOrder ?? current.sort_order,
    params.isActive === false ? 0 : 1,
    id,
  );
  appendAudit(db, {
    action: "admin.category.updated",
    actor: params.actor,
    summary: `Zmieniono kategorię dostępu: ${current.name}`,
    entityType: "access_category",
    entityId: id,
  });
  return getCategoryById(db, id)!;
}

/**
 * Kategoria „inne": własne pola definiowane przez użytkownika.
 * Zapisuje schemat pól w kategorii o slug `inne`.
 */
export function setCustomFields(db: Db, schema: FieldSchema, actor: AuditActor): AccessCategory {
  const category = getCategoryBySlug(db, "inne");
  if (!category) throw new Error('Brak kategorii „inne”');
  const sanitized = schema.map((field) => ({
    ...field,
    key: field.key.trim(),
    label: field.label.trim(),
    secret: field.type === "password" ? true : field.secret,
  }));
  db.prepare("UPDATE access_categories SET field_schema = ? WHERE id = ?").run(
    JSON.stringify(sanitized),
    category.id,
  );
  appendAudit(db, {
    action: "admin.category.updated",
    actor,
    summary: `Zmieniono pola kategorii „inne" (${sanitized.length})`,
    entityType: "access_category",
    entityId: category.id,
  });
  return getCategoryById(db, category.id)!;
}
