-- Purchase order approvals and the audit trail.
--
-- An order moves through a fixed set of statuses:
--
--   draft ──submit──▶ submitted ──approve──▶ approved ──(receipts)──▶ partially_received ──▶ received
--     │                 │   │
--     │                 │   └──reject──▶ rejected ──reopen──▶ draft
--     └──cancel──▶ cancelled ◀──cancel── submitted / approved
--
-- The API decides who may take each step; the trigger below makes sure no
-- other status change can be written, whatever the caller. Every step is
-- recorded in audit_events in the same transaction as the change itself.

ALTER TABLE purchase_orders
  ADD COLUMN submitted_by    uuid REFERENCES users (id),
  ADD COLUMN submitted_at    timestamptz,
  ADD COLUMN decided_by      uuid REFERENCES users (id),
  ADD COLUMN decided_at      timestamptz,
  ADD COLUMN decision_reason text CHECK (length(btrim(decision_reason)) BETWEEN 1 AND 500),
  ADD CONSTRAINT purchase_orders_submitted_pair
    CHECK ((submitted_by IS NULL) = (submitted_at IS NULL)),
  ADD CONSTRAINT purchase_orders_decided_pair
    CHECK ((decided_by IS NULL) = (decided_at IS NULL)),
  -- Four-eyes rule: whoever submitted an order can't approve or reject it.
  ADD CONSTRAINT purchase_orders_no_self_decision
    CHECK (decided_by IS NULL OR decided_by IS DISTINCT FROM submitted_by);

-- Approval queue: submitted orders, oldest submission first.
CREATE INDEX purchase_orders_submitted_idx ON purchase_orders (organization_id, submitted_at)
  WHERE status = 'submitted';

CREATE FUNCTION guard_purchase_order_status() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.status = OLD.status THEN
    RETURN NEW;
  END IF;
  IF (OLD.status, NEW.status) NOT IN (
       ('draft', 'submitted'),
       ('draft', 'cancelled'),
       ('submitted', 'approved'),
       ('submitted', 'rejected'),
       ('submitted', 'cancelled'),
       ('rejected', 'draft'),
       ('approved', 'cancelled'),
       ('approved', 'partially_received'),
       ('approved', 'received'),
       ('partially_received', 'received')
     ) THEN
    RAISE EXCEPTION 'purchase order cannot move from % to %', OLD.status, NEW.status
      USING ERRCODE = 'object_not_in_prerequisite_state';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER purchase_orders_status_transitions BEFORE UPDATE OF status ON purchase_orders
  FOR EACH ROW EXECUTE FUNCTION guard_purchase_order_status();

-- Who did what to which record, and why. Tenant-scoped and append-only.
-- entity_type + entity_id name the record (no foreign key, so one table can
-- serve every kind of record); from_status/to_status are set for status
-- changes; details holds small, non-sensitive facts such as order totals.
CREATE TABLE audit_events (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id),
  entity_type     text        NOT NULL CHECK (entity_type ~ '^[a-z][a-z_]{1,39}$'),
  entity_id       uuid        NOT NULL,
  action          text        NOT NULL CHECK (action ~ '^[a-z][a-z_]{1,39}\.[a-z][a-z_]{1,39}$'),
  actor_id        uuid        NOT NULL REFERENCES users (id),
  from_status     text,
  to_status       text,
  reason          text        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  details         jsonb       NOT NULL DEFAULT '{}'::jsonb CHECK (jsonb_typeof(details) = 'object'),
  occurred_at     timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT audit_events_status_pair CHECK ((from_status IS NULL) = (to_status IS NULL))
);

-- Timelines read one record's events in order; exports read a whole tenant.
CREATE INDEX audit_events_entity_idx
  ON audit_events (organization_id, entity_type, entity_id, occurred_at, id);
CREATE INDEX audit_events_org_time_idx ON audit_events (organization_id, occurred_at);

CREATE FUNCTION reject_audit_event_change() RETURNS trigger
  LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_events is append-only'
    USING ERRCODE = 'object_not_in_prerequisite_state';
END;
$$;

CREATE TRIGGER audit_events_append_only BEFORE UPDATE OR DELETE ON audit_events
  FOR EACH ROW EXECUTE FUNCTION reject_audit_event_change();

CREATE TRIGGER audit_events_no_truncate BEFORE TRUNCATE ON audit_events
  FOR EACH STATEMENT EXECUTE FUNCTION reject_audit_event_change();
