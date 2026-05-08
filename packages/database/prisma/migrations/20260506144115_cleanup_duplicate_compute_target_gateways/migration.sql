-- Older app versions enforced gateway ownership in application code only. A
-- race could leave multiple compute targets with the same non-null gateway_id.
-- Keep the most recent active target for each gateway. Archive duplicate
-- machine names before clearing gateway_id so the next legitimate registration
-- can rename the kept gateway row without colliding with stale duplicates.
WITH ranked_gateway_targets AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "gateway_id"
      ORDER BY
        "is_online" DESC,
        "last_seen_at" DESC,
        "updated_at" DESC,
        "created_at" DESC,
        "id" DESC
    ) AS gateway_rank
  FROM "compute_targets"
  WHERE "gateway_id" IS NOT NULL
)
UPDATE "compute_targets" AS target
SET
  "gateway_id" = NULL,
  "machine_name" = concat('archived-gateway-duplicate-', target."id"::text),
  "is_online" = false,
  "updated_at" = now()
FROM ranked_gateway_targets AS ranked
WHERE target."id" = ranked."id"
  AND ranked.gateway_rank > 1;
