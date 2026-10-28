-- PLN-1742 M1: a `github_user_connections` row becomes a token-less registry
-- entry when the GitHub credential is sourced from Clerk, so the stored cipher
-- is no longer required. Widening-only: existing rows keep their values and
-- every reader already had to handle "no usable credential".
ALTER TABLE "github_user_connections" ALTER COLUMN "access_token_encrypted" DROP NOT NULL;
