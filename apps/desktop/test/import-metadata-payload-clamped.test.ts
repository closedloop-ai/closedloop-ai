/**
 * @file import-metadata-payload-clamped.test.ts
 * @description ISS-5822: the worker's response-budget clamp signal has to be
 * DURABLE, not just countable.
 *
 * `buildImportMetadata` produces the JSON blob that becomes `sessions.metadata`,
 * survives the session row, and is forwarded wholesale to cloud sync. If the
 * clamp flag stops here, it dies with the in-memory session: the only thing that
 * ever saw it is an aggregate OTel counter that resets every tally window, and
 * every durable consumer — a local detail read, the synced cloud record — is
 * left unable to tell a truncated session from a complete one. That is the
 * failure this file exists to prevent, and it is the same reason FEA-2771
 * persists `parseQuality`.
 *
 * The paired negative proves the flag is not written unconditionally, and with
 * it the byte-identical-blob property the omit-when-absent shape buys: an
 * unclamped session gains no key, so no frozen golden-layer2 metadata sha256
 * drifts and no DATA_REVISION bump is required.
 */

import assert from "node:assert/strict";
import { test } from "vitest";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { buildImportMetadata } from "../src/main/database/import-metadata-builders.js";
import { makeSession } from "./normalized-session-test-utils.js";

function metadataOf(session: NormalizedSession): Record<string, unknown> {
  return JSON.parse(buildImportMetadata(session, Harness.Claude)) as Record<
    string,
    unknown
  >;
}

test("a clamped session persists payloadClamped into the metadata blob", () => {
  const metadata = metadataOf({
    ...makeSession({ sessionId: "clamped" }),
    payloadClamped: true,
  });

  assert.equal(metadata.payloadClamped, true);
});

test("an unclamped session's metadata blob is unchanged, key and all", () => {
  const session = makeSession({ sessionId: "intact" });

  const metadata = metadataOf(session);

  // `Object.hasOwn`, not `=== undefined`: serializing `payloadClamped: false`
  // would satisfy a value check while drifting the blob of every pre-existing
  // session — the churn the omit-when-absent shape exists to avoid.
  assert.equal(Object.hasOwn(metadata, "payloadClamped"), false);
});
