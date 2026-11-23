-- Purchasing: purchase orders and their lines, owned by one organization.
--
-- A purchase order is raised against one supplier for delivery to one
-- warehouse. Its number (PO-000001, ...) is allocated per organization from
-- purchase_order_numbers, so numbers have no gaps from other tenants and stay
-- unique even when two buyers create orders at the same moment.
--
-- Orders start as `draft`. Only a draft's lines can be changed; once an order
-- leaves draft its ordered quantities and prices are frozen (enforced by a
-- trigger, not only by the API). Orders and lines are never deleted.

CREATE TABLE purchase_order_numbers (
  organization_id uuid    PRIMARY KEY REFERENCES organizations (id),
  last_number     integer NOT NULL CHECK (last_number BETWEEN 1 AND 999999)
);

CREATE TABLE purchase_orders (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id),
  number          text        NOT NULL CHECK (number ~ '^PO-[0-9]{6}$'),
  status          text        NOT NULL DEFAULT 'draft'
                  CHECK (status IN ('draft', 'submitted', 'approved', 'rejected', 'cancelled',
                                    'partially_received', 'received')),
  supplier_id     uuid        NOT NULL,
  warehouse_id    uuid        NOT NULL,
  expected_on     date,
  notes           text        CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  created_by      uuid        NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, number),
  UNIQUE (organization_id, id),
  CONSTRAINT purchase_orders_supplier_fk FOREIGN KEY (organization_id, supplier_id)
    REFERENCES suppliers (organization_id, id),
  CONSTRAINT purchase_orders_warehouse_fk FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES warehouses (organization_id, id)
);

-- List screens page through an organization's orders, newest first,
-- optionally by status or supplier.
CREATE INDEX purchase_orders_list_idx ON purchase_orders (organization_id, created_at DESC);
CREATE INDEX purchase_orders_status_idx ON purchase_orders (organization_id, status);
CREATE INDEX purchase_orders_supplier_idx ON purchase_orders (organization_id, supplier_id);

CREATE TRIGGER purchase_orders_set_updated_at BEFORE UPDATE ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- unit_cost_cents is copied from the SKU when the line is created (or given
-- explicitly), so later catalog price changes don't rewrite existing orders.
-- A line total is capped at 10^13 cents so an order of up to 200 lines always
-- sums to an exact JavaScript number.
CREATE TABLE purchase_order_lines (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL,
  purchase_order_id uuid        NOT NULL,
  line_number       smallint    NOT NULL CHECK (line_number BETWEEN 1 AND 200),
  sku_id            uuid        NOT NULL,
  quantity_ordered  integer     NOT NULL CHECK (quantity_ordered BETWEEN 1 AND 1000000),
  unit_cost_cents   integer     NOT NULL CHECK (unit_cost_cents >= 0),
  line_total_cents  bigint      GENERATED ALWAYS AS (quantity_ordered::bigint * unit_cost_cents) STORED,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (purchase_order_id, line_number),
  -- One line per SKU; ordering more of a SKU means a larger quantity.
  UNIQUE (purchase_order_id, sku_id),
  UNIQUE (organization_id, id),
  CONSTRAINT purchase_order_lines_order_fk FOREIGN KEY (organization_id, purchase_order_id)
    REFERENCES purchase_orders (organization_id, id),
  CONSTRAINT purchase_order_lines_sku_fk FOREIGN KEY (organization_id, sku_id)
    REFERENCES skus (organization_id, id),
  CONSTRAINT purchase_order_lines_total_cap
    CHECK (quantity_ordered::bigint * unit_cost_cents <= 10000000000000)
);

CREATE INDEX purchase_order_lines_sku_idx ON purchase_order_lines (organization_id, sku_id);

CREATE TRIGGER purchase_order_lines_set_updated_at BEFORE UPDATE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Lines may only be added, removed or re-priced while their order is a draft.
-- Other columns added later (e.g. received quantities) stay updatable.
CREATE FUNCTION guard_purchase_order_lines() RETURNS trigger
  LANGUAGE plpgsql AS $$
DECLARE
  order_status text;
BEGIN
  IF TG_OP = 'UPDATE'
     AND NEW.purchase_order_id = OLD.purchase_order_id
     AND NEW.line_number = OLD.line_number
     AND NEW.sku_id = OLD.sku_id
     AND NEW.quantity_ordered = OLD.quantity_ordered
     AND NEW.unit_cost_cents = OLD.unit_cost_cents THEN
    RETURN NEW;
  END IF;

  SELECT status INTO order_status FROM purchase_orders
   WHERE id = CASE WHEN TG_OP = 'DELETE' THEN OLD.purchase_order_id
                   ELSE NEW.purchase_order_id END;

  IF order_status IS DISTINCT FROM 'draft' THEN
    RAISE EXCEPTION 'purchase order lines can only change while the order is a draft (status: %)',
      coalesce(order_status, 'missing')
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;

  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_order_lines_draft_only
  BEFORE INSERT OR UPDATE OR DELETE ON purchase_order_lines
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_order_lines();
