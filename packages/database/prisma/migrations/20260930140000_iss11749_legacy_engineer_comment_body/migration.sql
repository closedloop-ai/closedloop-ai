-- ISS-11749: the Engineer View (added 72df5a8fef, deleted 32cc4e3c15) posted
-- comments on NATIVE threads with a Liveblocks-shaped body: `version` plus a
-- `content` array of `children` paragraphs, no `type`. No body_format rule in
-- 20260930150000_iss11212_comment_contract_core matches that shape, so its
-- invariant failed the prod and stage deploys. This rewrites each such body
-- into the RICH_V1 doc `textBody()` (apps/api/app/comments/mention-body.ts)
-- builds from the row's own `plain_text`; that migration's `type = 'doc'` rule
-- then classifies it. The timestamp sorts before it so `migrate deploy` runs
-- this first. A row without `plain_text` is left for its invariant to report.
UPDATE "comments" AS c
SET "body" = jsonb_build_object(
  'type', 'doc',
  'content', jsonb_build_array(jsonb_build_object(
    'type', 'paragraph',
    'content', jsonb_build_array(
      jsonb_build_object('type', 'text', 'text', c."plain_text")
    )
  ))
)
FROM "comment_threads" AS t
WHERE c."thread_id" = t."id"
  AND t."source" = 'NATIVE'
  AND c."body" ->> 'type' IS NULL
  AND jsonb_typeof(c."body" -> 'content') = 'array'
  AND c."plain_text" <> '';
