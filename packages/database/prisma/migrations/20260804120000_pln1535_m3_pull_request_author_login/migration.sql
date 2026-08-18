-- PLN-1535 M3: add the PR author login to the projection so the Postgres-served
-- PR list can render the real author instead of the live path's "unknown"
-- fallback. Additive & nullable; existing rows stay NULL until a webhook/fetch
-- producer refreshes them.
ALTER TABLE "pull_request_detail" ADD COLUMN "author_login" TEXT;
