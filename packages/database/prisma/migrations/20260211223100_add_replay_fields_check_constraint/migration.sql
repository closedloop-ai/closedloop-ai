-- Enforce that runner_token_jti and runner_nonce are either both null or both non-null.
-- Prevents malformed writes from bypassing replay detection assumptions.
ALTER TABLE "loop_events"
ADD CONSTRAINT "loop_events_replay_fields_both_or_none"
CHECK (
  (runner_token_jti IS NULL AND runner_nonce IS NULL)
  OR
  (runner_token_jti IS NOT NULL AND runner_nonce IS NOT NULL)
);
