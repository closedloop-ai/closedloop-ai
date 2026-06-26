-- Custom SQL: Drop empty shadow tables (`preview_schemas` and
-- `preview_schemas_observations`) that `cloneDataFromPublic()` copied into
-- every preview schema. These are infrastructure-only tables and should not
-- exist inside preview schemas. The migration enumerates dynamically from
-- pg_namespace so the count does not need to be hardcoded.
--
-- Idempotent: DROP TABLE IF EXISTS is a no-op when the table is already gone.

DO $$
DECLARE
  schema_rec RECORD;
  drop_count INTEGER := 0;
BEGIN
  FOR schema_rec IN
    SELECT nspname FROM pg_namespace WHERE nspname LIKE 'preview_%' ORDER BY nspname
  LOOP
    EXECUTE format('DROP TABLE IF EXISTS %I.preview_schemas', schema_rec.nspname);
    EXECUTE format('DROP TABLE IF EXISTS %I.preview_schemas_observations', schema_rec.nspname);
    drop_count := drop_count + 1;
  END LOOP;

  RAISE NOTICE 'Dropped shadow tables from % preview schema(s)', drop_count;
END $$;
