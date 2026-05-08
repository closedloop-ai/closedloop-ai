-- Fix OAuth table id columns: schema uses @default(uuid(7)) which is
-- application-level (Prisma generates UUID v7 before INSERT). The DB
-- column should have no DEFAULT.
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "oauth_rate_limits" ALTER COLUMN "id" DROP DEFAULT;
ALTER TABLE "oauth_revoked_tokens" ALTER COLUMN "id" DROP DEFAULT;

-- Fix scopes column: schema declares String[] with no default, but the
-- original migration added DEFAULT ARRAY[]::TEXT[].
ALTER TABLE "oauth_authorization_codes" ALTER COLUMN "scopes" DROP DEFAULT;

-- Fix entity_links index names: Prisma truncates auto-generated names at
-- 63 characters.  The original migration used full-length names (67 chars).
ALTER INDEX "entity_links_organization_id_source_id_source_type_link_type_idx"
  RENAME TO "entity_links_organization_id_source_id_source_type_link_typ_idx";

ALTER INDEX "entity_links_organization_id_target_id_target_type_link_type_idx"
  RENAME TO "entity_links_organization_id_target_id_target_type_link_typ_idx";
