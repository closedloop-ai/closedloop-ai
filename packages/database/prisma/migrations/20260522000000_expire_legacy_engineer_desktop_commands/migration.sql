-- Data migration: expire DesktopCommand rows targeting the legacy /api/engineer/* namespace.
--
-- Background: The /api/engineer/* path prefix is being dropped. Any commands still in a
-- non-terminal state that target this namespace will never be dispatched or acknowledged,
-- so they must be transitioned to 'expired' before the code changes go live.
--
-- Schema note: 'path' is a top-level key in the request_payload JSON object.
-- Verified from desktopCommandStore.createCommand (apps/api/lib/desktop-command-store.ts):
--   requestPayload = stripTransientCommandFields(input)   -- keeps path as top-level key
--   db.desktopCommand.create({ data: { requestPayload: requestPayload as Prisma.InputJsonValue } })
-- and from CreateDesktopCommandInput (packages/api/src/types/compute-target.ts):
--   path: string  -- top-level field, not nested
--
-- Dry-run (run this SELECT before deploying to document row count in the PR description):
-- SELECT COUNT(*)
-- FROM desktop_commands
-- WHERE request_payload->>'path' LIKE '/api/engineer/%'
--   AND status IN ('queued', 'accepted', 'running');

UPDATE desktop_commands
SET
  status     = 'expired',
  finished_at = NOW()
WHERE
  request_payload->>'path' LIKE '/api/engineer/%'
  AND status IN ('queued', 'accepted', 'running');
