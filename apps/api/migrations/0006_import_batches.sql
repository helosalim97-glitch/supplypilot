-- CSV imports of stock movements. Uploading a file creates a batch in the
-- `previewed` state with one row per data record: the original cells, the
-- values picked out by the column mapping and, for a valid row, the movement
-- it would record. Nothing touches the stock ledger at this stage; applying
-- a batch is a separate step.

CREATE TABLE import_batches (
  id              uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid        NOT NULL REFERENCES organizations (id),
  kind            text        NOT NULL DEFAULT 'stock_movements'
                  CHECK (kind IN ('stock_movements')),
  file_name       text        NOT NULL CHECK (length(btrim(file_name)) BETWEEN 1 AND 255),
  -- SHA-256 of the uploaded content, to recognise the same file uploaded twice.
  file_sha256     char(64)    NOT NULL CHECK (file_sha256 ~ '^[0-9a-f]{64}$'),
  delimiter       char(1)     NOT NULL CHECK (delimiter IN (',', ';')),
  -- Header names in file order, and import field -> header name (or null).
  columns         jsonb       NOT NULL CHECK (jsonb_typeof(columns) = 'array'),
  column_mapping  jsonb       NOT NULL CHECK (jsonb_typeof(column_mapping) = 'object'),
  -- Movement type for rows without a type column or with an empty type cell.
  default_type    text        CHECK (default_type IN ('receipt', 'issue', 'adjustment')),
  status          text        NOT NULL DEFAULT 'previewed' CHECK (status IN ('previewed')),
  row_count       integer     NOT NULL CHECK (row_count BETWEEN 1 AND 2000),
  valid_count     integer     NOT NULL CHECK (valid_count BETWEEN 0 AND row_count),
  created_by      uuid        NOT NULL REFERENCES users (id),
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (organization_id, id)
);

CREATE INDEX import_batches_org_created_idx ON import_batches (organization_id, created_at DESC);
CREATE INDEX import_batches_file_idx ON import_batches (organization_id, file_sha256);

CREATE TABLE import_rows (
  organization_id uuid        NOT NULL,
  batch_id        uuid        NOT NULL,
  -- Position in the file, counting the header as row 1 (as a spreadsheet shows it).
  row_number      integer     NOT NULL CHECK (row_number >= 2),
  cells           jsonb       NOT NULL CHECK (jsonb_typeof(cells) = 'array'),
  mapped_values   jsonb       NOT NULL CHECK (jsonb_typeof(mapped_values) = 'object'),
  sku_id          uuid,
  warehouse_id    uuid,
  event_type      text        CHECK (event_type IN ('receipt', 'issue', 'adjustment')),
  quantity_delta  integer,
  reason          text        CHECK (length(btrim(reason)) BETWEEN 1 AND 500),
  reference       text        CHECK (length(btrim(reference)) BETWEEN 1 AND 120),
  occurred_at     timestamptz,
  -- [{ "field": ..., "message": ... }]; empty means the row is valid.
  errors          jsonb       NOT NULL DEFAULT '[]' CHECK (jsonb_typeof(errors) = 'array'),
  PRIMARY KEY (batch_id, row_number),
  CONSTRAINT import_rows_batch_fk FOREIGN KEY (organization_id, batch_id)
    REFERENCES import_batches (organization_id, id) ON DELETE CASCADE,
  CONSTRAINT import_rows_sku_fk FOREIGN KEY (organization_id, sku_id)
    REFERENCES skus (organization_id, id),
  CONSTRAINT import_rows_warehouse_fk FOREIGN KEY (organization_id, warehouse_id)
    REFERENCES warehouses (organization_id, id),
  -- A valid row carries a complete movement; an invalid row carries none.
  CONSTRAINT import_rows_movement_complete CHECK (
    CASE WHEN jsonb_array_length(errors) = 0
      THEN sku_id IS NOT NULL AND warehouse_id IS NOT NULL
           AND event_type IS NOT NULL AND quantity_delta IS NOT NULL
      ELSE sku_id IS NULL AND warehouse_id IS NULL
           AND event_type IS NULL AND quantity_delta IS NULL
    END
  ),
  -- Same sign rules as inventory_events.
  CONSTRAINT import_rows_delta_sign CHECK (
    CASE event_type
      WHEN 'receipt' THEN quantity_delta > 0
      WHEN 'issue' THEN quantity_delta < 0
      ELSE quantity_delta <> 0
    END
  )
);
