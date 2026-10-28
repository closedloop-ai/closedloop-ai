-- ISS-11826: the redeemed bootstrap credential remains single-use across
-- processes and retries. This nullable marker is additive for rows minted by
-- the already-deployed Slice 1 table.
ALTER TABLE "desktop_bootstrap_codes"
ADD COLUMN "consumed_at" TIMESTAMP(3);
