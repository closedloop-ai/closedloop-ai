-- Backfill judge_scores from historical artifact_evaluations.report_data
--
-- For each artifact_evaluation row with a valid report_data JSON containing a
-- stats array, this migration extracts one judge_scores row per CaseScore entry.
-- The matching metric is found by normalizing both metric_name and case_id
-- (lowercase, strip -judge/_judge/-score/_score suffix, replace - with _).
--
-- prompt_id is resolved by joining prompt_registry on organization_id + normalized name,
-- taking the highest version. NULL when no matching prompt exists.
--
-- Idempotent: ON CONFLICT (evaluation_id, case_id) DO NOTHING.
-- Safe to re-run on a database that already has partial judge_scores rows.

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
  -- Resolve prompt_id via normalized judge name matching, latest version
  (
    SELECT pr.id
    FROM prompt_registry pr
    INNER JOIN artifacts a ON a.id = ae.artifact_id
    WHERE pr.organization_id = a.organization_id
      AND LOWER(REPLACE(REGEXP_REPLACE(pr.name, '[-_](judge|score)$', '', 'i'), '-', '_'))
        = LOWER(REPLACE(REGEXP_REPLACE(s->>'case_id', '[-_](judge|score)$', '', 'i'), '-', '_'))
    ORDER BY pr.version DESC
    LIMIT 1
  ),
  s->>'case_id',
  COALESCE((metric_match->>'threshold')::float, 0),
  COALESCE((metric_match->>'score')::float, 0),
  COALESCE(metric_match->>'justification', ''),
  (s->>'final_status')::"EvalStatus",
  ae.created_at
FROM artifact_evaluations ae
CROSS JOIN LATERAL jsonb_array_elements(ae.report_data -> 'stats') AS s
CROSS JOIN LATERAL (
  -- Find the one metric whose normalized name matches the normalized case_id
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
  AND jsonb_typeof(ae.report_data -> 'stats') = 'array'
  AND s->>'case_id' IS NOT NULL
  AND s->>'final_status' IS NOT NULL
ON CONFLICT (evaluation_id, case_id) DO NOTHING;

-- VERIFICATION QUERY (run after migration to confirm backfill completeness):
--
-- SELECT
--   (SELECT COUNT(*) FROM judge_scores) AS backfilled_count,
--   (
--     SELECT COALESCE(SUM(jsonb_array_length(report_data -> 'stats')), 0)
--     FROM artifact_evaluations
--     WHERE report_data IS NOT NULL
--       AND jsonb_typeof(report_data) = 'object'
--       AND jsonb_typeof(report_data -> 'stats') = 'array'
--       AND jsonb_array_length(report_data -> 'stats') > 0
--   ) AS expected_max_count;
--
-- backfilled_count should be <= expected_max_count.
-- The difference represents CasScores with no matching metric (normalized case_id != metric_name),
-- which are intentionally skipped. A large gap may indicate a data format issue.
