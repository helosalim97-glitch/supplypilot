-- Catalog: suppliers, warehouses and SKUs, all owned by one organization.
-- Codes are unique per organization (case-insensitive). Records are archived,
-- never deleted, so stock events and purchase orders keep their references.

CREATE TABLE suppliers (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  code            citext      NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  name            text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  contact_email   citext      CHECK (contact_email ~ '^[^@\s]+@[^@\s]+$'),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  -- Target for same-organization foreign keys from other tables.
  UNIQUE (organization_id, id)
);

CREATE TRIGGER suppliers_set_updated_at BEFORE UPDATE ON suppliers
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE warehouses (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  code            citext      NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  name            text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 120),
  archived_at     timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id)
);

CREATE TRIGGER warehouses_set_updated_at BEFORE UPDATE ON warehouses
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- unit_cost_cents is an integer amount in the organization's currency, so
-- totals never go through floating point.
CREATE TABLE skus (
  id                    uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id       uuid        NOT NULL REFERENCES organizations (id) ON DELETE CASCADE,
  code                  citext      NOT NULL CHECK (code ~ '^[A-Za-z0-9][A-Za-z0-9._-]{0,39}$'),
  name                  text        NOT NULL CHECK (length(btrim(name)) BETWEEN 1 AND 200),
  unit                  text        NOT NULL CHECK (unit ~ '^[a-z][a-z0-9_]{0,15}$'),
  unit_cost_cents       integer     NOT NULL CHECK (unit_cost_cents >= 0),
  reorder_point         integer     NOT NULL DEFAULT 0 CHECK (reorder_point >= 0),
  preferred_supplier_id uuid,
  archived_at           timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, code),
  UNIQUE (organization_id, id),
  -- The preferred supplier must belong to the same organization as the SKU.
  FOREIGN KEY (organization_id, preferred_supplier_id)
    REFERENCES suppliers (organization_id, id)
);

CREATE INDEX skus_preferred_supplier_idx ON skus (organization_id, preferred_supplier_id)
  WHERE preferred_supplier_id IS NOT NULL;

CREATE TRIGGER skus_set_updated_at BEFORE UPDATE ON skus
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();
