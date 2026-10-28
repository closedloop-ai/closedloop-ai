/**
 * ISS-11262: the persisted `DocumentStatus` Prisma enum and the TypeScript
 * const (`@repo/loops-api`, re-exported by `packages/api/src/types/document.ts`)
 * name the same members. Root AGENTS.md lists them as two of the four layers a
 * new status must reach; this makes a one-sided addition fail `pnpm typecheck`
 * (the `expectTypeOf` line) and `pnpm test` (the runtime set comparison)
 * instead of relying on the author to remember the other side.
 */
import { DocumentStatus } from "@repo/api/src/types/document";
import { expect, expectTypeOf, test } from "vitest";
import { DocumentStatus as PersistedDocumentStatus } from "../generated/enums";

test("the Prisma DocumentStatus enum and the TypeScript const agree", () => {
  expectTypeOf<PersistedDocumentStatus>().toEqualTypeOf<DocumentStatus>();
  expect(new Set(Object.values(PersistedDocumentStatus))).toEqual(
    new Set(Object.values(DocumentStatus))
  );
});
