-- Migracja 1: schemat początkowy userbase.
PRAGMA foreign_keys = ON;

CREATE TABLE app_users (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  username          TEXT    NOT NULL UNIQUE COLLATE NOCASE,
  display_name      TEXT    NOT NULL,
  role              TEXT    NOT NULL CHECK (role IN ('admin','operator','audytor')),
  password_hash     TEXT    NOT NULL,
  totp_secret_enc   TEXT,
  totp_enabled      INTEGER NOT NULL DEFAULT 0,
  recovery_codes_enc TEXT,
  failed_attempts   INTEGER NOT NULL DEFAULT 0,
  locked_until      INTEGER,
  must_change_password INTEGER NOT NULL DEFAULT 0,
  is_active         INTEGER NOT NULL DEFAULT 1,
  created_at        INTEGER NOT NULL,
  last_login_at     INTEGER
);

-- Wersje klucza użyte do zaszyfrowania sekretów konta (TOTP, kody odzyskiwania).
CREATE TABLE app_user_secrets (
  user_id     INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  kind        TEXT    NOT NULL CHECK (kind IN ('totp','recovery')),
  key_version INTEGER NOT NULL DEFAULT 1,
  PRIMARY KEY (user_id, kind)
);

CREATE TABLE sessions (
  id           TEXT PRIMARY KEY,
  user_id      INTEGER NOT NULL REFERENCES app_users(id) ON DELETE CASCADE,
  token_hash   TEXT    NOT NULL UNIQUE,
  csrf_hash    TEXT    NOT NULL,
  created_at   INTEGER NOT NULL,
  last_seen_at INTEGER NOT NULL,
  expires_at   INTEGER NOT NULL,
  ip           TEXT,
  user_agent   TEXT,
  pending_2fa  INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX idx_sessions_user ON sessions(user_id);
CREATE INDEX idx_sessions_expires ON sessions(expires_at);

CREATE TABLE crypto_keys (
  version     INTEGER PRIMARY KEY,
  wrapped_dek TEXT    NOT NULL,
  created_at  INTEGER NOT NULL,
  retired_at  INTEGER
);

CREATE TABLE org_units (
  id        INTEGER PRIMARY KEY AUTOINCREMENT,
  type      TEXT    NOT NULL CHECK (type IN ('region','zaklad','sklep','biuro')),
  name      TEXT    NOT NULL,
  number    TEXT,
  parent_id INTEGER REFERENCES org_units(id) ON DELETE SET NULL,
  is_active INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  UNIQUE (type, name)
);
CREATE INDEX idx_org_parent ON org_units(parent_id);

CREATE TABLE access_categories (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  slug         TEXT    NOT NULL UNIQUE,
  name         TEXT    NOT NULL,
  icon         TEXT,
  field_schema TEXT    NOT NULL,
  sort_order   INTEGER NOT NULL DEFAULT 100,
  is_system    INTEGER NOT NULL DEFAULT 0,
  is_active    INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE workers (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  first_name   TEXT    NOT NULL,
  last_name    TEXT    NOT NULL,
  position     TEXT,
  org_unit_id  INTEGER REFERENCES org_units(id) ON DELETE SET NULL,
  email        TEXT,
  phone        TEXT,
  notes        TEXT,
  status       TEXT    NOT NULL DEFAULT 'aktywny' CHECK (status IN ('aktywny','zarchiwizowany')),
  search_blob  TEXT    NOT NULL DEFAULT '',
  created_at   INTEGER NOT NULL,
  updated_at   INTEGER NOT NULL,
  archived_at  INTEGER,
  archived_by  INTEGER REFERENCES app_users(id)
);
CREATE INDEX idx_workers_status ON workers(status);
CREATE INDEX idx_workers_name ON workers(last_name, first_name);
CREATE INDEX idx_workers_unit ON workers(org_unit_id);

CREATE TABLE accesses (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  worker_id       INTEGER NOT NULL REFERENCES workers(id) ON DELETE CASCADE,
  category_id     INTEGER NOT NULL REFERENCES access_categories(id),
  title           TEXT,
  status          TEXT    NOT NULL DEFAULT 'aktywny' CHECK (status IN ('aktywny','wycofany')),
  resource_owner  TEXT    NOT NULL DEFAULT 'firma' CHECK (resource_owner IN ('firma','pracownik')),
  created_at      INTEGER NOT NULL,
  updated_at      INTEGER NOT NULL,
  created_by      INTEGER REFERENCES app_users(id),
  revoked_at      INTEGER,
  revoked_by      INTEGER REFERENCES app_users(id)
);
CREATE INDEX idx_accesses_worker ON accesses(worker_id);
CREATE INDEX idx_accesses_category ON accesses(category_id);
CREATE INDEX idx_accesses_status ON accesses(status);

CREATE TABLE access_fields (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  access_id  INTEGER NOT NULL REFERENCES accesses(id) ON DELETE CASCADE,
  field_key  TEXT    NOT NULL,
  value_text TEXT,
  value_enc  TEXT,
  key_version INTEGER
);
CREATE INDEX idx_fields_access ON access_fields(access_id);
CREATE INDEX idx_fields_key ON access_fields(field_key);
CREATE INDEX idx_fields_text ON access_fields(field_key, value_text);

CREATE TABLE audit_events (
  seq           INTEGER PRIMARY KEY AUTOINCREMENT,
  at            INTEGER NOT NULL,
  actor_user_id INTEGER REFERENCES app_users(id),
  actor_name    TEXT,
  actor_ip      TEXT,
  action        TEXT    NOT NULL,
  entity_type   TEXT,
  entity_id     INTEGER,
  summary       TEXT    NOT NULL,
  details_json  TEXT,
  prev_hash     TEXT    NOT NULL,
  entry_hash    TEXT    NOT NULL
);
CREATE INDEX idx_audit_at ON audit_events(at);
CREATE INDEX idx_audit_actor ON audit_events(actor_user_id);
CREATE INDEX idx_audit_action ON audit_events(action);
CREATE INDEX idx_audit_entity ON audit_events(entity_type, entity_id);

CREATE TABLE record_history (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  entity_type   TEXT    NOT NULL,
  entity_id     INTEGER NOT NULL,
  field_key     TEXT    NOT NULL,
  old_value     TEXT,
  new_value     TEXT,
  actor_user_id INTEGER REFERENCES app_users(id),
  changed_at    INTEGER NOT NULL
);
CREATE INDEX idx_history_entity ON record_history(entity_type, entity_id, changed_at);
CREATE INDEX idx_history_at ON record_history(changed_at);

CREATE TABLE settings (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

-- Log audytowy jest tylko do dopisywania: blokujemy UPDATE i DELETE.
CREATE TRIGGER audit_events_no_update
BEFORE UPDATE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'Log audytowy jest niezmienny');
END;

CREATE TRIGGER audit_events_no_delete
BEFORE DELETE ON audit_events
BEGIN
  SELECT RAISE(ABORT, 'Log audytowy jest niezmienny');
END;
