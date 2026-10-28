-- ISS-12251 (PLN-2176 T-6.3): the session's creation time, taken from the
-- transcript file's birth time at import (falling back to the session's
-- started_at). NULL until an import fills it: rows the live hook or the Codex
-- OTel writer create, and rows that predate this column.
ALTER TABLE "sessions" ADD COLUMN "created_at" TEXT;
