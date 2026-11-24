-- Receiving goods against approved purchase orders, including partial shipments.
--
-- A receipt is one delivery: it lists how many units arrived for some of the
-- order's lines. Each receipt line also writes one `receipt` event to the
-- inventory ledger in the same transaction, so on-hand stock goes up exactly
-- when the receipt is recorded and never separately from it.
--
-- purchase_order_lines.quantity_received is the running total per line. The
-- CHECK below means a line can never be received beyond what was ordered,
-- whatever the caller does; the order moves to `partially_received` after
-- the first delivery and to `received` once every line is complete (the
-- status trigger from 0009 already allows exactly those edges).
--
-- Receipts carry the client's Idempotency-Key, so a delivery recorded twice
-- (a retried request, a scanner sending the same event again) adds stock
-- only once. Receipts and their lines are append-only, like the ledger.

ALTER TABLE purchase_order_lines
  ADD COLUMN quantity_received integer NOT NULL DEFAULT 0,
  ADD CONSTRAINT purchase_order_lines_received_within_ordered
    CHECK (quantity_received BETWEEN 0 AND quantity_ordered);

CREATE TABLE purchase_order_receipts (
  id                uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id   uuid        NOT NULL REFERENCES organizations (id),
  purchase_order_id uuid        NOT NULL,
  -- Supplier's delivery note or packing slip number, if any.
  reference         text        CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  notes             text        CHECK (length(btrim(notes)) BETWEEN 1 AND 1000),
  idempotency_key   text        NOT NULL CHECK (idempotency_key ~ '^[A-Za-z0-9._:-]{8,100}$'),
  -- SHA-256 of the normalized request, to spot a key reused for another delivery.
  request_hash      char(64)    NOT NULL,
  received_by       uuid        NOT NULL REFERENCES users (id),
  received_at       timestamptz NOT NULL DEFAULT now(),
  recorded_at       timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, idempotency_key),
  UNIQUE (organization_id, id),
  CONSTRAINT purchase_order_receipts_order_fk FOREIGN KEY (organization_id, purchase_order_id)
    REFERENCES purchase_orders (organization_id, id)
);

CREATE INDEX purchase_order_receipts_order_idx
  ON purchase_order_receipts (organization_id, purchase_order_id, recorded_at);

CREATE TABLE purchase_order_receipt_lines (
  id                     uuid    PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id        uuid    NOT NULL,
  receipt_id             uuid    NOT NULL,
  purchase_order_line_id uuid    NOT NULL,
  quantity               integer NOT NULL CHECK (quantity BETWEEN 1 AND 1000000),
  -- The ledger event this line produced; one event per receipt line.
  inventory_event_id     uuid    NOT NULL,
  UNIQUE (receipt_id, purchase_order_line_id),
  UNIQUE (organization_id, inventory_event_id),
  CONSTRAINT purchase_order_receipt_lines_receipt_fk FOREIGN KEY (organization_id, receipt_id)
    REFERENCES purchase_order_receipts (organization_id, id),
  CONSTRAINT purchase_order_receipt_lines_line_fk FOREIGN KEY (organization_id, purchase_order_line_id)
    REFERENCES purchase_order_lines (organization_id, id),
  CONSTRAINT purchase_order_receipt_lines_event_fk FOREIGN KEY (organization_id, inventory_event_id)
    REFERENCES inventory_events (organization_id, id)
);

CREATE INDEX purchase_order_receipt_lines_line_idx
  ON purchase_order_receipt_lines (organization_id, purchase_order_line_id);

CREATE FUNCTION reject_receipt_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION '% is append-only; record a correction instead', TG_TABLE_NAME
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER purchase_order_receipts_append_only
  BEFORE UPDATE OR DELETE ON purchase_order_receipts
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_change();

CREATE TRIGGER purchase_order_receipts_no_truncate
  BEFORE TRUNCATE ON purchase_order_receipts
  FOR EACH STATEMENT EXECUTE FUNCTION reject_receipt_change();

CREATE TRIGGER purchase_order_receipt_lines_append_only
  BEFORE UPDATE OR DELETE ON purchase_order_receipt_lines
  FOR EACH ROW EXECUTE FUNCTION reject_receipt_change();

CREATE TRIGGER purchase_order_receipt_lines_no_truncate
  BEFORE TRUNCATE ON purchase_order_receipt_lines
  FOR EACH STATEMENT EXECUTE FUNCTION reject_receipt_change();
