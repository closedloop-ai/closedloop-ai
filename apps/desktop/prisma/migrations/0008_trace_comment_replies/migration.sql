-- Store desktop-local trace comment replies on the anchored root row so replies
-- can be created while offline and upsynced once cloud access is available.
ALTER TABLE "trace_comments"
  ADD COLUMN "replies" JSONB NOT NULL DEFAULT [];
