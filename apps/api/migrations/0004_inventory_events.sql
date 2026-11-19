-- Stock ledger: every change to on-hand stock is one row in inventory_events.
-- Rows are append-only. A mistake is fixed with a `correction` event that
-- points at the event it compensates, so the full history stays auditable.
--
-- quantity_delta is signed: receipts add stock, issues remove it, adjustments
-- (stock counts) and corrections may go either way but are never zero.

CREATE TABLE inventory_events (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations (id),
  sku_id            uuid        NOT NULL,
  warehouse_id      uuid        NOT NULL,
  event_type        text        NOT NULL
                    CHECK (event_type IN ('receipt', 'issue', 'adjustment', 'correction')),
  quantity_delta    integer     NOT NULL,
  reason            text        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reference         text        CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  corrects_event_id uuid,
  -- Client-supplied key; retrying a request with the same key returns the
  -- original event instead of recording the movement twice.
  idempotency_key   text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  -- SHA-256 of the normalized request, to spot a key reused for another movement.
  request_hash      char(64)    NOT NULL,
  created_by        uuid        NOT NULL REFERENCES users (id),
  occurred_at       timestamptz NOT NULL DEFAULT now(),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  CONSTRAINT inventory_events_sku_fk FOREIGN KEY (organization_id, sku_id)
    REFERENCES skus (organization_id, id),
  CONSTRAINT inventory_events_warehouse_fk FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES warehouses (organization_id, id),
  CONSTRAINT inventory_events_corrects_fk FOREIGN KEY (organization_id, corrects_event_id)
    REFERENCES inventory_events (organization_id, id),
  CONSTRAINT inventory_events_delta_sign CHECK (
    CASE event_type
      WHEN 'receipt' THEN quantity_delta > 0
      WHEN 'issue' THEN quantity_delta < 0
      ELSE quantity_delta <> 0
    END
  ),
  CONSTRAINT inventory_events_correction_target CHECK (
    (event_type = 'correction') = (corrects_event_id IS NOT NULL)
  )
);

-- Balance projection and per-SKU history read events in this order.
CREATE INDEX inventory_events_stock_idx
  ON inventory_events (organization_id, sku_id, warehouse_id, occurred_at, recorded_at);

CREATE INDEX inventory_events_corrects_idx ON inventory_events (organization_id, corrects_event_id)
  WHERE corrects_event_id IS NOT NULL;

CREATE FUNCTION reject_inventory_event_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'inventory_events is append-only; record a correction event instead'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER inventory_events_append_only BEFORE UPDATE OR DELETE ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION reject_inventory_event_change();

CREATE TRIGGER inventory_events_no_truncate BEFORE TRUNCATE ON inventory_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_inventory_event_change();
