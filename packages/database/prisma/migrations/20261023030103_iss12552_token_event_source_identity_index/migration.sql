-- ISS-12552 (AC-020): session allocation finds the other sessions in an
-- organization that hold one source usage, by jsonb equality on
-- source_identity, so a fork's copied usage is allocated once. Hash, because
-- an identity can carry 64 ids of up to 2048 characters, past a btree entry's
-- size limit. Prisma cannot express a concurrent index build; keep this as one
-- bare statement so deployment does not block token-event writes or accept an
-- invalid prior index.
-- CreateIndex
CREATE INDEX CONCURRENTLY "agent_session_token_events_source_identity_idx" ON "agent_session_token_events" USING HASH ("source_identity");
