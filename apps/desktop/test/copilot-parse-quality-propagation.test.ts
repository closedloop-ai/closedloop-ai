/**
 * @file copilot-parse-quality-propagation.test.ts
 * @description ISS-6885. Computing a parse-quality signal is worthless if it is
 * dropped before a consumer can see it, so this covers the three hops a Copilot
 * `parseQuality` has to survive after `parseCliEventFile` produces it:
 *
 *   1. LOCAL — `buildImportMetadata` serializes it into the `sessions.metadata`
 *      blob, the single row both desktop reads (`loadSyncedSessions` →
 *      session-detail projection, and the list load) hand back verbatim.
 *   2. CLOUD — `compactMetadataForPreview` is the bounded copier every synced
 *      session's metadata passes through on the way to the API
 *      (`sanitizeSessionForSync` → `compactSessionMetadataForSync`) AND again on
 *      the server before persist (`sanitizeMetadataForPersist`). It is generic,
 *      not an allow-list, so the risk it carries is the depth and key CAPS
 *      silently dropping a nested object — which is exactly what `parseQuality`
 *      is.
 *   3. The historical Copilot pass runs in the parse UTILITY PROCESS, so its
 *      sessions cross `historicalParseWorkerResponseSchema` — a `.strict()`
 *      boundary that rejects the WHOLE response, silently dropping the source,
 *      if a payload carries a key the schema does not model.
 *
 * The malformed-line counting itself lives in `copilot-cli-event-parser.test.ts`;
 * this file only asserts that what it computed still exists downstream.
 */
import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import path from "node:path";
import {
  compactMetadataForPreview,
  OMITTED_METADATA_KEYS,
} from "@repo/lib/agent-sessions/metadata-preview";
import { test } from "vitest";
import { parseCliEventFile } from "../src/main/collectors/copilot/copilot-parser.js";
import {
  createHistoricalParseWorkerParsedResponse,
  historicalParseWorkerResponseSchema,
} from "../src/main/collectors/engine/historical-parse-worker-protocol.js";
import {
  Harness,
  type NormalizedSession,
} from "../src/main/collectors/types.js";
import { buildImportMetadata } from "../src/main/database/import-metadata-builders.js";
import { makeTempDir } from "./normalized-session-test-utils.js";

/** The signal a corrupt middle line must produce and keep all the way down. */
const EXPECTED_QUALITY = {
  totalLines: 3,
  malformedLines: 1,
  truncatedFinalLine: false,
} as const;

/**
 * Parse a Copilot CLI stream whose MIDDLE line is corrupt — the ticket's
 * reproduction, and the only shape whose signal is a data-integrity warning
 * rather than a benign in-progress tail.
 */
async function parseCorruptedCopilotSession(): Promise<NormalizedSession> {
  const filePath = path.join(
    makeTempDir("copilot-quality-propagation-"),
    "events.jsonl"
  );
  writeFileSync(
    filePath,
    [
      JSON.stringify({
        type: "user_message",
        timestamp: "2026-03-09T16:00:00.000Z",
        payload: { text: "u1" },
      }),
      '{"type":"assistant_message","timestamp":"2026-03-09T16:00:30.000Z","payl',
      JSON.stringify({
        type: "assistant_message",
        timestamp: "2026-03-09T16:01:00.000Z",
        payload: { text: "a1" },
      }),
    ].join("\n"),
    "utf8"
  );
  const parsed = await parseCliEventFile(filePath, "propagation");
  if (parsed === null) {
    throw new Error("expected the corrupted CLI fixture to parse to a session");
  }
  return parsed;
}

test("a Copilot parseQuality survives into the persisted metadata blob the LOCAL reads serve", async () => {
  const session = await parseCorruptedCopilotSession();
  assert.deepEqual(session.parseQuality, EXPECTED_QUALITY);

  // `buildImportMetadata` is the only writer of `sessions.metadata`; both the
  // detail read and the list read return that stored object without projecting
  // fields out of it, so surviving serialization is surviving the local reads.
  const stored = JSON.parse(buildImportMetadata(session, Harness.Copilot));
  assert.deepEqual(stored.parseQuality, EXPECTED_QUALITY);
});

test("a Copilot parseQuality survives the CLOUD sync metadata compaction", async () => {
  const session = await parseCorruptedCopilotSession();
  const stored = JSON.parse(buildImportMetadata(session, Harness.Copilot));

  // The desktop→API hop and the API's pre-persist sanitize both run this exact
  // function. A nested object is what its depth/key caps can eat, so assert the
  // whole shape rather than the presence of the key.
  const forCloud = compactMetadataForPreview(stored);
  assert.deepEqual(forCloud?.parseQuality, EXPECTED_QUALITY);
});

test("no metadata strip list drops parseQuality on either read", () => {
  // `OMITTED_METADATA_KEYS` is the ONE declaration of "drop this key", consumed
  // by the local LIST read's SQL projection (`sessionMetadataSelectExpression`)
  // and by the cloud compaction above. Adding `parseQuality` to it would silence
  // the signal on both reads at once with no other test noticing, so pin it out.
  assert.equal(OMITTED_METADATA_KEYS.has("parseQuality"), false);
});

test("a Copilot session carrying parseQuality passes the strict parse-worker boundary", async () => {
  // The historical import runs the Copilot collector in the utility process, so
  // a payload the `.strict()` response schema does not model would reject the
  // whole batch and drop the source with no partial result. Drive the REAL
  // parser output — a hand-authored literal would only ever re-prove the schema
  // against itself, and would stay green precisely when the parser starts
  // emitting a key the boundary does not know. Validate, then read the field
  // back off the VALIDATED response.
  const session = await parseCorruptedCopilotSession();

  const response = createHistoricalParseWorkerParsedResponse("req-1", [
    session,
  ]);
  const result = historicalParseWorkerResponseSchema.safeParse(response);
  assert.equal(result.success, true, "the strict boundary must accept it");
  assert.deepEqual(
    result.success && "sessions" in result.data
      ? result.data.sessions[0]?.parseQuality
      : undefined,
    EXPECTED_QUALITY
  );
});

test("an OLDER desktop payload with no parseQuality still crosses the boundary", () => {
  // Cross-repo/version skew: `parseQuality` is optional and additive, so a
  // session parsed by a build that never emitted one must not be rejected —
  // and must read back as ABSENT rather than as a zeroed clean parse.
  const legacy: NormalizedSession = {
    sessionId: "copilot-cli-legacy",
    name: "legacy",
    cwd: null,
    model: null,
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-03-09T16:00:00.000Z",
    endedAt: "2026-03-09T16:01:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 0,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "copilot",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: 0,
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    skills: [],
    hooks: [],
    artifacts: { prs: [], issues: [], repo: null },
    prLinks: [],
  };

  const response = createHistoricalParseWorkerParsedResponse("req-2", [legacy]);
  const result = historicalParseWorkerResponseSchema.safeParse(response);
  assert.equal(result.success, true);
  assert.equal(
    result.success && "sessions" in result.data
      ? result.data.sessions[0]?.parseQuality
      : "unreachable",
    undefined,
    "absent, not a fabricated zeroed signal"
  );
});
