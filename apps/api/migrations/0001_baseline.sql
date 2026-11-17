-- Baseline: shared database helpers used by later tables.

-- Case-insensitive text for emails and SKU codes.
CREATE EXTENSION IF NOT EXISTS citext;

-- Keeps updated_at current on mutable tables:
--   CREATE TRIGGER <table>_set_updated_at BEFORE UPDATE ON <table>
--     FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger
LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END;
$$;
