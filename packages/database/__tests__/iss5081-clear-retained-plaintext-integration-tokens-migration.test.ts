import { describe, expect, it } from "vitest";
import { migrationDdl } from "./test-helpers/migration-index-ddl";

/**
 * ISS-5081: the SQL text of the plaintext-clearing data migration.
 *
 * The sibling `__tests__/integration/iss5081-…integration.test.ts` executes this
 * same file against real Postgres and is where the behaviour is proven — but
 * that suite self-skips without a `DATABASE_URL` and its CI lane is advisory,
 * so this file is the pin that actually blocks. It matters here more than
 * usual: the write is irreversible, and a wrong predicate is discovered only
 * after production rows already hold NULL where a credential used to be.
 *
 * The negative pins are the point. Each encodes a decision:
 *
 *  - predicating a half on the OTHER half's ciphertext would delete the refresh
 *    token of a row that holds access ciphertext and a plaintext-only refresh
 *    token, which is that organization's only means of refreshing;
 *  - dropping `<> ''` would clear the plaintext beside an empty-string
 *    ciphertext, which the reader of the time (`resolveIntegrationToken`, later
 *    removed) did not treat as a credential at all (`if (encrypted)`), so the
 *    row would lose its only working copy;
 *  - any schema DDL, or any row-destroying verb, belongs to a later and
 *    separately approved step.
 *
 * Reads declarative migration.sql DDL only — never implementation source.
 */

const MIGRATION =
  "20260916120000_iss5081_clear_retained_plaintext_integration_tokens";

const WHITESPACE_G = /\s+/g;
const ROW_DESTRUCTION_RE = /\b(DELETE|TRUNCATE|INSERT)\b/i;
const SCHEMA_CHANGE_RE =
  /\b(ALTER\s+TABLE|CREATE\s+TABLE|DROP\s+TABLE|DROP\s+COLUMN)\b/i;

function statements(): string[] {
  return migrationDdl(MIGRATION)
    .split(";")
    .map((statement) => statement.replace(WHITESPACE_G, " ").trim())
    .filter((statement) => statement.length > 0);
}

describe("ISS-5081 retained-plaintext clearing migration", () => {
  it("clears each token column only where that column's own usable ciphertext exists", () => {
    expect(statements()).toEqual([
      'UPDATE "google_integrations" SET "access_token" = NULL WHERE "access_token" IS NOT NULL AND "access_token_encrypted" IS NOT NULL AND "access_token_encrypted" <> \'\'',
      'UPDATE "google_integrations" SET "refresh_token" = NULL WHERE "refresh_token" IS NOT NULL AND "refresh_token_encrypted" IS NOT NULL AND "refresh_token_encrypted" <> \'\'',
      'UPDATE "linear_integrations" SET "access_token" = NULL WHERE "access_token" IS NOT NULL AND "access_token_encrypted" IS NOT NULL AND "access_token_encrypted" <> \'\'',
      'UPDATE "linear_integrations" SET "refresh_token" = NULL WHERE "refresh_token" IS NOT NULL AND "refresh_token_encrypted" IS NOT NULL AND "refresh_token_encrypted" <> \'\'',
    ]);
  });

  it("changes no schema and destroys no row", () => {
    // Scanned against the STRIPPED DDL, not the raw file: a header sentence
    // that merely names one of these verbs must not red the suite, and those
    // are exactly the words this migration's prose needs.
    const ddl = migrationDdl(MIGRATION);

    expect(ddl).not.toMatch(SCHEMA_CHANGE_RE);
    expect(ddl).not.toMatch(ROW_DESTRUCTION_RE);
  });
});
