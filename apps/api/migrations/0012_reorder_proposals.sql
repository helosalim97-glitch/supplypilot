-- Reorder proposals: the worker's recommendation to reorder one SKU for one
-- warehouse from its preferred supplier, kept with the numbers behind it.
--
-- A proposal is only ever a suggestion. It starts `pending`; a manager either
-- approves it (which raises a *draft* purchase order that still goes through
-- the normal submit / approve flow) or rejects it with a reason. A later run
-- whose numbers differ replaces an open proposal: the old one becomes
-- `superseded` and a new one is added. Once a proposal has left `pending` it
-- never changes again, and proposals are never deleted.
--
--   pending ──approve──▶ approved (purchase_order_id set)
--      │ └───reject───▶ rejected (decision_reason set)
--      └──next run────▶ superseded

CREATE TABLE reorder_proposals (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations (id),
  sku_id            uuid        NOT NULL,
  warehouse_id      uuid        NOT NULL,
  supplier_id       uuid        NOT NULL,
  status            text        NOT NULL DEFAULT 'pending'
                    CHECK (status IN ('pending', 'approved', 'rejected', 'superseded')),
  -- The calculation as the worker returned it.
  suggested_qty     integer     NOT NULL CHECK (suggested_qty BETWEEN 1 AND 1000000),
  on_hand           integer     NOT NULL CHECK (on_hand >= 0),
  on_order          integer     NOT NULL CHECK (on_order >= 0),
  reorder_point     integer     NOT NULL CHECK (reorder_point >= 0),
  safety_stock      integer     NOT NULL CHECK (safety_stock >= 0),
  order_up_to       integer     NOT NULL CHECK (order_up_to >= 0),
  -- Demand, lead time and run settings, so a reviewer can redo the arithmetic.
  evidence          jsonb       NOT NULL CHECK (jsonb_typeof(evidence) = 'object'),
  warnings          text[]      NOT NULL DEFAULT '{}',
  -- SHA-256 of the inputs and result; equal digests mean nothing changed.
  inputs_digest     text        NOT NULL CHECK (inputs_digest ~ '^[0-9a-f]{64}$'),
  calculated_at     timestamptz NOT NULL,
  -- Who started the run that produced this proposal.
  created_by        uuid        NOT NULL REFERENCES users (id),
  decided_by        uuid        REFERENCES users (id),
  decided_at        timestamptz,
  decision_reason   text        CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 500),
  approved_qty      integer     CHECK (approved_qty BETWEEN 1 AND 1000000),
  purchase_order_id uuid,
  superseded_at     timestamptz,
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id),
  CONSTRAINT reorder_proposals_sku_fk FOREIGN KEY (organization_id, sku_id)
    REFERENCES skus (organization_id, id),
  CONSTRAINT reorder_proposals_warehouse_fk FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES warehouses (organization_id, id),
  CONSTRAINT reorder_proposals_supplier_fk FOREIGN KEY (organization_id, supplier_id)
    REFERENCES suppliers (organization_id, id),
  CONSTRAINT reorder_proposals_purchase_order_fk FOREIGN KEY (organization_id, purchase_order_id)
    REFERENCES purchase_orders (organization_id, id),
  CONSTRAINT reorder_proposals_decided_pair CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  CONSTRAINT reorder_proposals_decision_matches_status CHECK (
    (status IN ('approved', 'rejected')) = (decided_by IS NOT NULL)
  ),
  -- An approval always records the order it raised and the quantity ordered.
  CONSTRAINT reorder_proposals_approval CHECK (
    (status = 'approved') = (purchase_order_id IS NOT NULL AND approved_qty IS NOT NULL)
  ),
  CONSTRAINT reorder_proposals_rejection CHECK (
    status <> 'rejected' OR decision_reason IS NOT NULL
  ),
  CONSTRAINT reorder_proposals_superseded CHECK (
    (status = 'superseded') = (superseded_at IS NOT NULL)
  )
);

-- At most one open proposal per SKU and warehouse.
CREATE UNIQUE INDEX reorder_proposals_one_pending
  ON reorder_proposals (organization_id, sku_id, warehouse_id) WHERE status = 'pending';
CREATE INDEX reorder_proposals_list_idx
  ON reorder_proposals (organization_id, created_at DESC, id);
CREATE INDEX reorder_proposals_status_idx ON reorder_proposals (organization_id, status);

CREATE TRIGGER reorder_proposals_set_updated_at BEFORE UPDATE ON reorder_proposals
  FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Only a pending proposal may change, and only by leaving `pending`; the
-- recommendation itself is never edited.
CREATE FUNCTION guard_reorder_proposal() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'reorder proposals are never deleted'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF OLD.status <> 'pending' OR NEW.status = 'pending' THEN
    RAISE EXCEPTION 'reorder proposal cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  IF (NEW.organization_id, NEW.sku_id, NEW.warehouse_id, NEW.supplier_id, NEW.suggested_qty,
      NEW.on_hand, NEW.on_order, NEW.reorder_point, NEW.safety_stock, NEW.order_up_to,
      NEW.evidence, NEW.warnings, NEW.inputs_digest, NEW.calculated_at, NEW.created_by)
     IS DISTINCT FROM
     (OLD.organization_id, OLD.sku_id, OLD.warehouse_id, OLD.supplier_id, OLD.suggested_qty,
      OLD.on_hand, OLD.on_order, OLD.reorder_point, OLD.safety_stock, OLD.order_up_to,
      OLD.evidence, OLD.warnings, OLD.inputs_digest, OLD.calculated_at, OLD.created_by) THEN
    RAISE EXCEPTION 'a reorder proposal''s recommendation cannot be edited'
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER reorder_proposals_guard BEFORE UPDATE OR DELETE ON reorder_proposals
  FOR EACH ROW EXECUTE FUNCTION guard_reorder_proposal();
