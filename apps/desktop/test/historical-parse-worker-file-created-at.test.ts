/**
 * @file historical-parse-worker-file-created-at.test.ts
 * @description ISS-12251 (PLN-2176 T-6.1): `fileCreatedAt` crosses the
 * historical-parse worker's `.strict()` response boundary with its value, and a
 * payload without it (an older or newer worker) still parses with the key
 * absent rather than `null`.
 */
import assert from "node:assert/strict";
import { test } from "vitest";
import {
  createHistoricalParseWorkerParsedResponse,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

const BIRTH_MS = Date.parse("2024-03-09T15:00:00.000Z");

function roundTrip(session: NormalizedSession) {
  return historicalParseWorkerResponseSchema.safeParse(
    createHistoricalParseWorkerParsedResponse("file-created-at", [session])
  );
}

test("fileCreatedAt survives the worker response boundary", () => {
  const session = makeSession("with-birth");
  session.fileCreatedAt = BIRTH_MS;
  const [parsed] = parsedSessions(roundTrip(session));
  assert.equal(parsed.fileCreatedAt, BIRTH_MS);
});

test("a payload without fileCreatedAt parses with the key absent", () => {
  const session = makeSession("without-birth");
  assert.equal("fileCreatedAt" in session, false);
  const [parsed] = parsedSessions(roundTrip(session));
  assert.equal("fileCreatedAt" in parsed, false);
});
