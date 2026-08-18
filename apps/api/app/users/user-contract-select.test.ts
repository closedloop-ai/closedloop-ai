import { Prisma } from "@repo/database";
import { describe, expect, it } from "vitest";
import {
  USER_COLUMNS_WITHHELD_FROM_CLIENTS,
  USER_CONTRACT_SELECT,
} from "./service";

/**
 * ISS-5195 schema-drift guard.
 *
 * The leak was not a wrong select — it was the ABSENCE of one, so every column
 * the `User` model happened to carry rode out to clients. An explicit select
 * fixes today's columns; this file is what stops tomorrow's from drifting back
 * in unnoticed.
 *
 * It reads the real column list from `Prisma.UserScalarFieldEnum` (the generated
 * runtime enum, not a text scan of `schema.prisma` — see the no-raw-text-source-
 * scan gate) and asserts that every scalar column is classified exactly once, as
 * either publicly exposed or deliberately withheld. Add a column to the model
 * and this fails until someone decides which it is.
 *
 * It lives outside `service.test.ts` because that suite factory-mocks
 * `@repo/database`, and the mocked namespace has no `UserScalarFieldEnum` — the
 * assertion needs the real generated one to mean anything.
 */
describe("User column classification stays exhaustive (ISS-5195)", () => {
  const modelColumns = Object.keys(Prisma.UserScalarFieldEnum);
  const exposed = Object.keys(USER_CONTRACT_SELECT);
  const withheld: readonly string[] = USER_COLUMNS_WITHHELD_FROM_CLIENTS;

  it("classifies every scalar column as exposed or withheld", () => {
    const unclassified = modelColumns.filter(
      (column) => !(exposed.includes(column) || withheld.includes(column))
    );

    // A new column landing here means a `User` field was added to the schema
    // without deciding whether clients may see it. Add it to
    // USER_CONTRACT_SELECT (and to the shared `User` type plus the public
    // OpenAPI schema) if it is public; add it to
    // USER_COLUMNS_WITHHELD_FROM_CLIENTS if it is not.
    expect(unclassified).toEqual([]);
  });

  it("classifies no column both ways", () => {
    expect(exposed.filter((column) => withheld.includes(column))).toEqual([]);
  });

  it("withholds only columns that still exist on the model", () => {
    // A renamed or dropped column would otherwise leave a stale entry that
    // silently stops protecting anything.
    expect(withheld.filter((column) => !modelColumns.includes(column))).toEqual(
      []
    );
  });

  it("keeps the encrypted Claude API key off the wire", () => {
    // The specific regression: `claudeApiKeyEncrypted` reached every read-scoped
    // API key holder for every user in the organization.
    expect(exposed).not.toContain("claudeApiKeyEncrypted");
    expect(withheld).toContain("claudeApiKeyEncrypted");
  });
});
