-- Applying a previewed import. `POST .../imports/:id/apply` queues the batch;
-- a background worker claims it, records each valid row as a stock movement
-- in file order and writes the outcome back onto the row.
--
--   previewed -> queued -> applying -> applied
--                   ^          |
--                   +- failed <+   (unexpected error; applying again resumes)
--
-- Rows are deduplicated twice: a row identical to an earlier row of the same
-- file is skipped, and every row is recorded with an idempotency key derived
-- from its movement, so a row already recorded by an earlier import (or an
-- earlier attempt of this one) is not recorded again.

ALTER TABLE import_batches DROP CONSTRAINT import_batches_status_check;

ALTER TABLE import_batches
  ADD COLUMN applied_by      uuid        REFERENCES users (id),
  ADD COLUMN queued_at       timestamptz,
  ADD COLUMN started_at      timestamptz,
  ADD COLUMN finished_at     timestamptz,
  -- Bumped on every claim; a worker only finishes the attempt it claimed.
  ADD COLUMN attempts        integer     NOT NULL DEFAULT 0 CHECK (attempts >= 0),
  ADD COLUMN applied_count   integer     NOT NULL DEFAULT 0 CHECK (applied_count >= 0),
  ADD COLUMN duplicate_count integer     NOT NULL DEFAULT 0 CHECK (duplicate_count >= 0),
  ADD COLUMN rejected_count  integer     NOT NULL DEFAULT 0 CHECK (rejected_count >= 0),
  ADD COLUMN failure_reason  text        CHECK (length(btrim(failure_reason)) BETWEEN 1 AND 500);

ALTER TABLE import_batches
  ADD CONSTRAINT import_batches_status_check
    CHECK (status IN ('previewed', 'queued', 'applying', 'applied', 'failed')),
  ADD CONSTRAINT import_batches_outcome_counts
    CHECK (applied_count + duplicate_count + rejected_count <= valid_count),
  -- Once queued, a batch keeps who asked for it and when.
  ADD CONSTRAINT import_batches_queue_state CHECK (
    (status = 'previewed') = (queued_at IS NULL)
    AND (status = 'previewed') = (applied_by IS NULL)
  ),
  ADD CONSTRAINT import_batches_applied_state CHECK (
    (status = 'applied') = (finished_at IS NOT NULL)
  ),
  ADD CONSTRAINT import_batches_failed_state CHECK (
    (status = 'failed') = (failure_reason IS NOT NULL)
  );

-- The worker's queue: oldest queued batch first, plus stale `applying` ones.
CREATE INDEX import_batches_queue_idx ON import_batches (queued_at)
  WHERE status IN ('queued', 'applying');

ALTER TABLE import_rows
  -- null until the worker reaches the row; invalid rows are never applied.
  ADD COLUMN outcome          text        CHECK (outcome IN ('applied', 'duplicate', 'rejected')),
  ADD COLUMN event_id         uuid,
  ADD COLUMN duplicate_of_row integer,
  ADD COLUMN outcome_message  text        CHECK (length(btrim(outcome_message)) BETWEEN 1 AND 500),
  ADD COLUMN processed_at     timestamptz;

ALTER TABLE import_rows
  ADD CONSTRAINT import_rows_event_fk FOREIGN KEY (organization_id, event_id)
    REFERENCES inventory_events (organization_id, id),
  ADD CONSTRAINT import_rows_outcome_only_valid
    CHECK (outcome IS NULL OR jsonb_array_length(errors) = 0),
  ADD CONSTRAINT import_rows_outcome_processed
    CHECK ((outcome IS NULL) = (processed_at IS NULL)),
  ADD CONSTRAINT import_rows_duplicate_earlier
    CHECK (duplicate_of_row IS NULL OR duplicate_of_row < row_number),
  -- applied: the event it recorded. duplicate: either the earlier row of this
  -- file or the event already in the ledger. rejected: why, and no event.
  ADD CONSTRAINT import_rows_outcome_shape CHECK (
    CASE outcome
      WHEN 'applied' THEN event_id IS NOT NULL AND duplicate_of_row IS NULL
                          AND outcome_message IS NULL
      WHEN 'duplicate' THEN (event_id IS NULL) <> (duplicate_of_row IS NULL)
                            AND outcome_message IS NOT NULL
      WHEN 'rejected' THEN event_id IS NULL AND duplicate_of_row IS NULL
                           AND outcome_message IS NOT NULL
      ELSE event_id IS NULL AND duplicate_of_row IS NULL AND outcome_message IS NULL
    END
  );
