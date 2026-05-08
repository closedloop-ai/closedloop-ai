-- Add explicit scope model for API keys.
ALTER TABLE "api_keys"
ADD COLUMN "scopes" TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[];

-- Backward compatibility: existing keys get full privileges.
UPDATE "api_keys"
SET "scopes" = ARRAY['read', 'write', 'delete', 'admin']::TEXT[]
WHERE cardinality("scopes") = 0;
