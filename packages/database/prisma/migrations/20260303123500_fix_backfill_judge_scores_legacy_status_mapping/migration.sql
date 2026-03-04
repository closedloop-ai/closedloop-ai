-- Backfill judge_scores for legacy report_data final_status encoding.
--
-- Context:
-- A prior backfill expected final_status to already be EvalStatus enum text.
-- Historical data stores status as numeric strings:
--   1 -> PASSED
--   2 -> NEEDS_IMPROVEMENT
--   3 -> FAILED
--
-- This migration inserts only missing rows and remains idempotent.
-- It keeps existing metric/case matching behavior from the original backfill.

INSERT INTO judge_scores (
  id,
  evaluation_id,
  prompt_id,
  case_id,
  threshold,
  score,
  justification,
  final_status,
  created_at
)
SELECT
  gen_random_uuid(),
  ae.id,
  -- Resolve prompt_id via normalized judge name matching, latest version.
  (
    SELECT pr.id
    FROM prompt_registry pr
    INNER JOIN artifacts a ON a.id = ae.artifact_id
    WHERE pr.organization_id = a.organization_id
      AND pr.prompt_type = 'JUDGE'
      AND LOWER(REPLACE(REGEXP_REPLACE(pr.name, '[-_](judge|score)$', '', 'i'), '-', '_'))
        = LOWER(REPLACE(REGEXP_REPLACE(s->>'case_id', '[-_](judge|score)$', '', 'i'), '-', '_'))
    ORDER BY pr.version DESC
    LIMIT 1
  ),
  s->>'case_id',
  COALESCE((metric_match->>'threshold')::float, 0),
  COALESCE((metric_match->>'score')::float, 0),
  COALESCE(metric_match->>'justification', ''),
  (
    CASE s->>'final_status'
      WHEN '1' THEN 'PASSED'
      WHEN '2' THEN 'NEEDS_IMPROVEMENT'
      WHEN '3' THEN 'FAILED'
      ELSE NULL
    END
  )::"EvalStatus",
  ae.created_at
FROM artifact_evaluations ae
CROSS JOIN LATERAL jsonb_array_elements(
  CASE
    WHEN jsonb_typeof(ae.report_data -> 'stats') = 'array' THEN ae.report_data -> 'stats'
    ELSE '[]'::jsonb
  END
) AS s
CROSS JOIN LATERAL (
  -- Keep the same metric matching contract as the original backfill.
  SELECT m AS metric_match
  FROM jsonb_array_elements(
    CASE
      WHEN jsonb_typeof(s -> 'metrics') = 'array' THEN s -> 'metrics'
      ELSE '[]'::jsonb
    END
  ) AS m
  WHERE LOWER(REPLACE(REGEXP_REPLACE(m->>'metric_name', '[-_](judge|score)$', '', 'i'), '-', '_'))
      = LOWER(REPLACE(REGEXP_REPLACE(s->>'case_id', '[-_](judge|score)$', '', 'i'), '-', '_'))
  LIMIT 1
) matched
WHERE ae.report_data IS NOT NULL
  AND jsonb_typeof(ae.report_data) = 'object'
  AND s->>'case_id' IS NOT NULL
  AND s->>'final_status' IN ('1', '2', '3')
ON CONFLICT (evaluation_id, case_id) DO NOTHING;
