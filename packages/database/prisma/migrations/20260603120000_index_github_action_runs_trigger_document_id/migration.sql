-- Add a partial expression index on github_action_runs for symphony-dispatch
-- lookups by documentId stored inside trigger_data.
--
-- Why hand-written (per packages/database/CLAUDE.md):
--   Prisma's schema DSL cannot express indexes on JSON-path expressions
--   (`trigger_data->>'documentId'`) nor partial WHERE clauses. Prisma's
--   schema-vs-DB diff ignores objects it cannot introspect into its model,
--   so this index does not register as drift (same pattern as the partial
--   unique index in 20260319195219_add_partial_unique_loop_artifact_command_version).
--
-- Why we need it:
--   PLN-787 dropped workstream_id from github_action_runs. Two callers now
--   filter by trigger_data->>'documentId':
--     - apps/api/app/documents/document-service.ts (findAll DISTINCT ON)
--     - apps/api/app/documents/generation-status-helpers.ts (fetchGitHubActionsStatus)
--   Without an expression index the planner falls back to a scan of every
--   symphony-dispatch run in the org. The WHERE clause keeps the index narrow
--   (only dispatch runs carry a documentId in trigger_data).
CREATE INDEX IF NOT EXISTS "github_action_runs_trigger_document_id_idx"
ON "github_action_runs" ((trigger_data->>'documentId'))
WHERE workflow_name = 'symphony-dispatch';
