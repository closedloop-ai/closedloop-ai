-- ISS-12209: when a session's owner-authored name (`name_override`) last
-- changed. Desktop polls renames since a cursor so it can write each one into
-- the harness's own title (Claude Code `custom-title`, Codex thread name) on the
-- machine holding the transcript. Additive and nullable: a row renamed before
-- this column existed has no time and is simply not in the feed.
ALTER TABLE "session_detail" ADD COLUMN "name_override_updated_at" TIMESTAMP(3);
