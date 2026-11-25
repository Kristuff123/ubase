/** Typy współdzielone między serwerem a UI. */

export type Role = "admin" | "operator" | "audytor";

export type FieldType =
  | "text"
  | "password"
  | "textarea"
  | "select"
  | "multiselect"
  | "checkbox"
  | "date"
  | "ref_org_unit";

export type FieldDef = {
  key: string;
  label: string;
  type: FieldType;
  required?: boolean;
  secret?: boolean;
  placeholder?: string;
  options?: string[];
  unitType?: "region" | "zaklad" | "sklep" | "biuro";
  showWhen?: Record<string, string[]>;
  help?: string;
};

export type FieldSchema = FieldDef[];

export type AccessCategory = {
  id: number;
  slug: string;
  name: string;
  icon: string | null;
  field_schema: string;
  sort_order: number;
  is_system: number;
  is_active: number;
};

export type OrgUnit = {
  id: number;
  type: "region" | "zaklad" | "sklep" | "biuro";
  name: string;
  number: string | null;
  parent_id: number | null;
  is_active: number;
  created_at: number;
};

export type Worker = {
  id: number;
  first_name: string;
  last_name: string;
  position: string | null;
  org_unit_id: number | null;
  email: string | null;
  phone: string | null;
  notes: string | null;
  status: "aktywny" | "zarchiwizowany";
  created_at: number;
  updated_at: number;
  archived_at: number | null;
  archived_by: number | null;
};

export type Access = {
  id: number;
  worker_id: number;
  category_id: number;
  title: string | null;
  status: "aktywny" | "wycofany";
  resource_owner: "firma" | "pracownik";
  created_at: number;
  updated_at: number;
  created_by: number | null;
  revoked_at: number | null;
  revoked_by: number | null;
};

export type AccessFieldValue = {
  key: string;
  label: string;
  type: FieldType;
  secret: boolean;
  values: string[];
  /** Dla pól sekretnych — czy wartość jest ustawiona (bez ujawniania treści). */
  hasValue: boolean;
  /** Dla `ref_org_unit` — typ jednostki (do rozwiązania nazw w UI). */
  unitType?: "region" | "zaklad" | "sklep" | "biuro";
};

export type AccessView = {
  id: number;
  categorySlug: string;
  categoryName: string;
  categoryIcon: string | null;
  title: string | null;
  status: "aktywny" | "wycofany";
  resourceOwner: "firma" | "pracownik";
  createdAt: number;
  updatedAt: number;
  revokedAt: number | null;
  createdBy: number | null;
  fields: AccessFieldValue[];
  secretsCount: number;
};

export type WorkerListItem = {
  id: number;
  firstName: string;
  lastName: string;
  position: string | null;
  orgUnitName: string | null;
  orgUnitType: string | null;
  status: "aktywny" | "zarchiwizowany";
  email: string | null;
  accessCount: number;
  categories: { slug: string; name: string; count: number }[];
  updatedAt: number;
};

export type WorkerDetail = WorkerListItem & {
  phone: string | null;
  notes: string | null;
  createdAt: number;
  archivedAt: number | null;
  accesses: AccessView[];
};

export type AuditEventView = {
  seq: number;
  at: number;
  actorName: string | null;
  actorIp: string | null;
  action: string;
  entityType: string | null;
  entityId: number | null;
  summary: string;
  details: unknown;
  entryHash: string;
  prevHash: string;
};

export type HistoryEntry = {
  id: number;
  fieldKey: string;
  oldValue: string | null;
  newValue: string | null;
  actorName: string | null;
  changedAt: number;
};

export type ImportPreviewRow = {
  rowNumber: number;
  values: Record<string, string>;
  status: "ok" | "duplicate" | "error" | "warning";
  messages: string[];
  normalized: {
    firstName: string;
    lastName: string;
    position: string | null;
    email: string | null;
    phone: string | null;
    orgUnitName: string | null;
  } | null;
};

export type ImportPreview = {
  columns: string[];
  suggestedMapping: Record<string, string>;
  rows: ImportPreviewRow[];
  unknownUnits: string[];
  summary: { total: number; ok: number; duplicate: number; error: number; warning: number };
  /**
   * Ile wierszy faktycznie wejdzie przy `onlyValid=true`: status „ok" oraz
   * „uwaga" z rozpoznaną jednostką. UI pokazuje tę liczbę na przycisku importu —
   * `summary.ok` zaniżałoby ją, bo wiersze z uwagą też są importowane.
   */
  importable: number;
};
