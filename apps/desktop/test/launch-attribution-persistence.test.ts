/**
 * ISS-7259: the launch-attribution facet's two persistence boundaries.
 *
 * The parser producing the facet is not the same thing as the facet surviving to
 * a row. Two hops sit in between and each can silently drop it: the historical
 * parse worker's `.strict()` response schema (which rejects the WHOLE session, not
 * just an unmodelled key), and `buildImportMetadata`, whose blob is what reaches
 * SQLite and cloud sync. Both are asserted here through the production entry
 * points.
 */
import assert from "node:assert/strict";
import { LaunchThreadSource } from "@repo/lib/harness/launch-attribution";
import { test } from "vitest";
import {
  HistoricalParseWorkerResponseType,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { buildImportMetadata } from "../src/main/database/import-metadata-builders.js";
import {
  makeSession,
  parsedSessions,
} from "./historical-parse-worker-response-support.js";

/**
 * A distinctive facet: every member carries a value nothing else in the fixture
 * or the production defaults could supply, so an assertion on it cannot be
 * satisfied by a parser that dropped the field and a builder that invented one.
 */
const FACET = {
  threadSource: LaunchThreadSource.Subagent,
  firstAttributedSkill: "cl-produce",
  observedSkillCount: 3,
  firstAttributedRecordIndex: 251,
  observedRecordCount: 381,
  promptSource: "typed",
  agentRole: "review-soul",
  agentNickname: "Leibniz",
  parentThreadId: "019ff86a-38b0-7cf3-8b8f-30db8edc9bc6",
  depth: 2,
} as const;

function sessionWithFacet(sessionId: string): NormalizedSession {
  return { ...makeSession(sessionId), harnessLaunchAttribution: { ...FACET } };
}

function workerResponse(sessions: NormalizedSession[]) {
  return historicalParseWorkerResponseSchema.safeParse({
    type: HistoricalParseWorkerResponseType.Parsed,
    requestId: "historical-parse-iss-7259",
    sessions,
  });
}

test("the worker .strict() boundary carries the whole launch-attribution facet through", () => {
  const sessions = parsedSessions(workerResponse([sessionWithFacet("wire")]));

  // deepEqual on the WHOLE facet: a key-by-key check would stay green if the
  // schema silently dropped one member, which is exactly the failure this
  // boundary produces.
  assert.deepEqual(sessions[0]?.harnessLaunchAttribution, { ...FACET });
});

test("a session that captured no attribution round-trips with no facet key at all", () => {
  const sessions = parsedSessions(workerResponse([makeSession("bare")]));

  // The positive sibling: omission has to survive as omission, or every
  // pre-ISS-7259 payload changes shape at the boundary.
  assert.equal(sessions[0]?.harnessLaunchAttribution, undefined);
  assert.equal("harnessLaunchAttribution" in (sessions[0] ?? {}), false);
});

test("the boundary rejects a facet carrying a key it does not model", () => {
  // Proves the guard is real rather than incidental: `.strict()` is what makes a
  // newly-emitted member fail loudly here instead of being stripped in silence
  // and reading as unsupported on every hydrated render.
  const rogue = {
    ...makeSession("rogue"),
    harnessLaunchAttribution: { ...FACET, agentPath: "/root/secret_topic" },
  };

  assert.equal(workerResponse([rogue as NormalizedSession]).success, false);
});

test("the boundary rejects an unrecognised threadSource rather than persisting it", () => {
  const rogue = {
    ...makeSession("bad-source"),
    harnessLaunchAttribution: { threadSource: "orchestrator" },
  };

  // The parser normalizes an unfamiliar value to `unknown` before it ever gets
  // here; a raw one reaching the wire means a producer skipped that step.
  assert.equal(
    workerResponse([rogue as unknown as NormalizedSession]).success,
    false
  );
});

test("buildImportMetadata persists the facet verbatim into the session blob", () => {
  const metadata = JSON.parse(
    buildImportMetadata(sessionWithFacet("persist"), Harness.Claude)
  );

  assert.deepEqual(metadata.harnessLaunchAttribution, { ...FACET });
});

test("buildImportMetadata omits the key when nothing was captured", () => {
  const withFacet = JSON.parse(
    buildImportMetadata(sessionWithFacet("with"), Harness.Claude)
  );
  const without = JSON.parse(
    buildImportMetadata(makeSession("without"), Harness.Claude)
  );

  assert.equal("harnessLaunchAttribution" in without, false);
  // And the omission is the ONLY difference the facet makes to the blob, which
  // is what keeps an unattributed session's metadata byte-identical to main and
  // off the `sessionDataChanged` re-import path. Destructured rather than
  // deleted or set to undefined: assigning `undefined` would leave the key in
  // `Object.keys` and make this comparison pass without proving anything.
  const { harnessLaunchAttribution: _facet, ...withFacetRemoved } = withFacet;
  assert.deepEqual(
    Object.keys(withFacetRemoved).sort(),
    Object.keys(without).sort()
  );
});
