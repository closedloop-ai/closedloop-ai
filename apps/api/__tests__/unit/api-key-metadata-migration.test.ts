import { readFileSync } from "node:fs";
import path from "node:path";

const migrationPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/migrations/20260423110000_add_desktop_managed_api_key_metadata/migration.sql"
);
const schemaPath = path.resolve(
  import.meta.dirname,
  "../../../../packages/database/prisma/schema.prisma"
);
const sourceColumnBackfillPattern =
  /ADD COLUMN\s+"source"\s+"ApiKeySource"\s+NOT NULL\s+DEFAULT 'USER_CREATED'/;
const gatewayIdColumnPattern = /ADD COLUMN\s+"gateway_id"\s+TEXT/;
const boundPublicKeyColumnPattern = /ADD COLUMN\s+"bound_public_key"\s+TEXT/;
const explicitExistingRowsBackfillPattern =
  /UPDATE "api_keys"\s+SET "source" = 'USER_CREATED',\s+"gateway_id" = NULL,\s+"bound_public_key" = NULL;/;

/**
 * Regression coverage for the PLN-319 API-key metadata migration contract.
 */
describe("desktop-managed API key metadata migration", () => {
  it("backfills existing api_keys rows as USER_CREATED with null desktop metadata", () => {
    const sql = readFileSync(migrationPath, "utf-8");

    expect(sql).toMatch(sourceColumnBackfillPattern);
    expect(sql).toMatch(gatewayIdColumnPattern);
    expect(sql).toMatch(boundPublicKeyColumnPattern);
    expect(sql).toMatch(explicitExistingRowsBackfillPattern);
  });

  it("keeps the Prisma schema default on USER_CREATED for non-Desktop inserts", () => {
    const schema = readFileSync(schemaPath, "utf-8");

    expect(schema).toContain(
      "source         ApiKeySource @default(USER_CREATED)"
    );
    expect(schema).toContain('gatewayId      String?      @map("gateway_id")');
    expect(schema).toContain(
      'boundPublicKey String?      @map("bound_public_key")'
    );
  });
});
