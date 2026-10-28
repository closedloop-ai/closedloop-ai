-- ISS-12585: drop the session's retired recording user and the rename-feed
-- cursor (operator ruling, Kerensa Whitlock, 2026-10-15/16: "remove the columns").
-- Dropping `user_id` also drops its foreign key to `users` and both indexes
-- keyed on these columns (`session_detail_user_id_session_started_at_idx`,
-- `session_detail_name_override_feed_idx`), so no separate DROP is needed.
--
-- destructive-migration-ok(session_detail.user_id): no reader or writer since ISS-12585 phase 1 (#8852) and ISS-12592 (#8859); the Owner is artifacts.assignee_id and the uploader artifacts.created_by_id. Dropped by operator instruction without an @ignore release first.
-- destructive-migration-ok(session_detail.name_override_updated_at): the deleted rename feed's cursor (ISS-12592, #8859); no reader or writer remains.
SET lock_timeout = '5s';

ALTER TABLE "session_detail" DROP COLUMN "name_override_updated_at",
DROP COLUMN "user_id";

RESET lock_timeout;
