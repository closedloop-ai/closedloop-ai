-- ISS-7096: record which environment (normalized apiOrigin of the active saved
-- config) a compute target was registered in. The compute-target id is the
-- trailing segment of every sync source key, so this mapping is what lets the
-- outbox lanes distinguish a RETIRED key of the active environment (adoptable,
-- ISS-7007) from a key owned by ANOTHER environment (parked until that
-- environment is active again). Written at lane hydration for the live target;
-- historical targets are attributed lazily when adoption proves ownership.
-- IF NOT EXISTS, so an untracked-store baseline adoption re-applying the chain
-- heals instead of throwing (migration-baseline-adoption.test.ts; the 0052/0054
-- precedent).
CREATE TABLE IF NOT EXISTS "compute_target_environments" (
    "compute_target_id" TEXT NOT NULL PRIMARY KEY,
    "environment_key" TEXT NOT NULL,
    "first_seen_at" TEXT NOT NULL,
    "last_seen_at" TEXT NOT NULL
);
