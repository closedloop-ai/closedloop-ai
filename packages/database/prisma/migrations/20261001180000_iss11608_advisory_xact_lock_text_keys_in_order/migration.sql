-- ISS-11608 (PLN-2140 step 1): take several transaction-scoped advisory locks
-- in ONE round trip, in the order the caller passes them.
--
-- Hand-written because Prisma cannot express a function.
--
-- The loop is the ordering guarantee. A set-returning form
-- (`SELECT pg_advisory_xact_lock(...) FROM unnest($1) ... ORDER BY k`) does not
-- constrain acquisition order, and a SQL sort uses the database collation
-- (`en_US.utf8`), which disagrees with JavaScript's `.sort()`: `symphonya`
-- sorts before `closedloop-ai` in SQL and after it in JS. Mixed with the
-- per-key JS-sorted path during a rolling deploy, the ORDER BY form deadlocked
-- 560 times in the PLN-2140 spike; this function deadlocked 0 times.
--
-- Each key takes the same lock slot as
-- `pg_advisory_xact_lock(hashtextextended(key, 0))`, so callers of this
-- function and of the single-key form exclude each other.
CREATE FUNCTION advisory_xact_lock_text_keys_in_order(keys text[]) RETURNS void
LANGUAGE plpgsql AS $$
DECLARE k text;
BEGIN
  FOREACH k IN ARRAY keys LOOP
    -- Both functions are STRICT: a NULL key would lock nothing and return.
    IF k IS NULL THEN
      RAISE EXCEPTION 'advisory_xact_lock_text_keys_in_order: NULL key';
    END IF;
    PERFORM pg_advisory_xact_lock(hashtextextended(k, 0));
  END LOOP;
END $$;

COMMENT ON FUNCTION advisory_xact_lock_text_keys_in_order(text[]) IS
  'ISS-11608: acquires pg_advisory_xact_lock(hashtextextended(key, 0)) for each key in the ARRAY ORDER GIVEN and never re-sorts. A SQL sort uses the database collation, which disagrees with the application sort, so callers must pass keys deduplicated and sorted in application code. Same lock slot as the single-key form.';
