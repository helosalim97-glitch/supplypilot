-- Stock balance projection: current on-hand quantity per SKU and warehouse,
-- maintained from inventory_events by a trigger in the same transaction as
-- the event insert, so the ledger and the balance can never disagree.
--
-- Negative-stock rule: on_hand may not drop below zero. A movement that would
-- do so fails its INSERT with a check_violation on
-- stock_balances_on_hand_non_negative and nothing is recorded. The rule looks
-- at the current total, not at the balance on a back-dated occurred_at.

CREATE TABLE stock_balances (
  organization_id  uuid        NOT NULL REFERENCES organizations (id),
  sku_id           uuid        NOT NULL,
  warehouse_id     uuid        NOT NULL,
  on_hand          integer     NOT NULL
                   CONSTRAINT stock_balances_on_hand_non_negative CHECK (on_hand >= 0),
  event_count      integer     NOT NULL CHECK (event_count > 0),
  -- Last event applied to this balance (by recording order).
  last_event_id    uuid        NOT NULL,
  -- Latest business time among the applied events.
  last_occurred_at timestamptz NOT NULL,
  created_at       timestamptz NOT NULL DEFAULT now(),
  updated_at       timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (organization_id, sku_id, warehouse_id),
  CONSTRAINT stock_balances_sku_fk FOREIGN KEY (organization_id, sku_id)
    REFERENCES skus (organization_id, id),
  CONSTRAINT stock_balances_warehouse_fk FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES warehouses (organization_id, id),
  CONSTRAINT stock_balances_last_event_fk FOREIGN KEY (organization_id, last_event_id)
    REFERENCES inventory_events (organization_id, id)
);

-- Listing by warehouse ("what is in WH-01?").
CREATE INDEX stock_balances_warehouse_idx ON stock_balances (organization_id, warehouse_id);

-- Backfill from events recorded before this migration. Fails (and rolls the
-- migration back) if the existing ledger already nets to negative stock.
INSERT INTO stock_balances
  (organization_id, sku_id, warehouse_id, on_hand, event_count, last_event_id, last_occurred_at)
SELECT organization_id,
       sku_id,
       warehouse_id,
       sum(quantity_delta),
       count(*),
       (array_agg(id ORDER BY recorded_at DESC, id DESC))[1],
       max(occurred_at)
  FROM inventory_events
 GROUP BY organization_id, sku_id, warehouse_id;

-- Upserts the balance row. ON CONFLICT DO UPDATE takes a row lock, so two
-- concurrent issues for the same SKU and warehouse are applied one after the
-- other and the second one sees the first one's result.
CREATE FUNCTION apply_inventory_event_to_balance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  INSERT INTO stock_balances AS b
    (organization_id, sku_id, warehouse_id, on_hand, event_count, last_event_id, last_occurred_at)
  VALUES
    (NEW.organization_id, NEW.sku_id, NEW.warehouse_id, NEW.quantity_delta, 1, NEW.id, NEW.occurred_at)
  ON CONFLICT (organization_id, sku_id, warehouse_id) DO UPDATE
    SET on_hand          = b.on_hand + EXCLUDED.on_hand,
        event_count      = b.event_count + 1,
        last_event_id    = EXCLUDED.last_event_id,
        last_occurred_at = greatest(b.last_occurred_at, EXCLUDED.last_occurred_at),
        updated_at       = now();
  RETURN NULL;
END;
$$;

CREATE TRIGGER inventory_events_apply_balance AFTER INSERT ON inventory_events
  FOR EACH ROW EXECUTE FUNCTION apply_inventory_event_to_balance();

-- Reconciliation check: rows here mean a balance differs from its ledger.
-- Expected to be empty; used by tests and operators.
CREATE VIEW stock_balance_drift AS
SELECT organization_id,
       sku_id,
       warehouse_id,
       b.on_hand AS projected_on_hand,
       e.ledger_on_hand
  FROM stock_balances b
  FULL JOIN (
    SELECT organization_id, sku_id, warehouse_id, sum(quantity_delta) AS ledger_on_hand
      FROM inventory_events
     GROUP BY organization_id, sku_id, warehouse_id
  ) e USING (organization_id, sku_id, warehouse_id)
 WHERE b.on_hand IS DISTINCT FROM e.ledger_on_hand;
