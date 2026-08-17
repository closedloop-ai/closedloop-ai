/**
 * @file repository-default-authority-row-boundary.test.ts
 * @description ISS-5838 persisted-row trust-boundary coverage. A structurally
 * incomplete SQLite row is rejected before compatibility normalization.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { authorityFromStoredRow } from "../src/main/database/repository-default-authority-store.js";

test("rejects a structurally incomplete persisted authority row", () => {
  assert.equal(
    authorityFromStoredRow({
      provider: "github",
      providerRepositoryId: "repository-1",
    }),
    undefined
  );
});
