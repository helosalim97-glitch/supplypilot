-- Let issues and negative adjustments draw down existing stock.
--
-- The trigger from 0005 upserted with INSERT ... ON CONFLICT DO UPDATE and
-- put the movement's own quantity_delta in the proposed row. PostgreSQL checks
-- CHECK constraints on that proposed row before it looks for a conflict, so
-- any negative delta failed stock_balances_on_hand_non_negative even when the
-- balance had plenty of stock. Only receipts and positive adjustments got
-- through.
--
-- The new version updates the existing balance first and only inserts when
-- there is none yet:
--
--   * existing balance: UPDATE adds the delta; the CHECK sees the real new
--     total, so the negative-stock rule still applies (same constraint name,
--     so the API keeps mapping it to 409 insufficient_stock). The UPDATE
--     locks the row, so concurrent issues for the same SKU and warehouse run
--     one after the other and the second sees the first one's result.
--   * no balance yet: INSERT the delta as the opening balance. A negative
--     delta fails the CHECK here, which is right: there is nothing to issue.
--   * no balance, but another transaction creates it at the same moment:
--     the INSERT does nothing on conflict and the UPDATE is retried against
--     the row that now exists.

CREATE OR REPLACE FUNCTION apply_inventory_event_to_balance() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  FOR attempt IN 1..2 LOOP
    UPDATE stock_balances AS b
       SET on_hand          = b.on_hand + NEW.quantity_delta,
           event_count      = b.event_count + 1,
           last_event_id    = NEW.id,
           last_occurred_at = greatest(b.last_occurred_at, NEW.occurred_at),
           updated_at       = now()
     WHERE b.organization_id = NEW.organization_id
       AND b.sku_id          = NEW.sku_id
       AND b.warehouse_id    = NEW.warehouse_id;
    IF FOUND THEN
      RETURN NULL;
    END IF;

    INSERT INTO stock_balances
      (organization_id, sku_id, warehouse_id, on_hand, event_count, last_event_id, last_occurred_at)
    VALUES
      (NEW.organization_id, NEW.sku_id, NEW.warehouse_id, NEW.quantity_delta, 1, NEW.id, NEW.occurred_at)
    ON CONFLICT (organization_id, sku_id, warehouse_id) DO NOTHING;
    IF FOUND THEN
      RETURN NULL;
    END IF;
  END LOOP;

  RAISE EXCEPTION 'could not apply inventory event % to its stock balance', NEW.id;
END;
$$;
