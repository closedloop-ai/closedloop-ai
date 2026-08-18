/**
 * @file golden-layer2-agent-ids-alias-parity.test.ts
 * @description ISS-5105 review guard: the layer-2 `agents` re-derivation must
 * decide "is this delegation claimed?" on the same IDENTITY production uses.
 *
 * `expectedSubagentRowIds` re-derives the store's expected subagent rows from
 * the dossier, deliberately without inheriting the write lane's rule. Identity
 * is not that rule, though: a delegation's `id` and its `providerToolUseId` are
 * two spellings of ONE tool use, and `buildSubagentDedupIndex` collapses them
 * with `delegationClaimKey` before counting claimants. Tallying the raw strings
 * instead scored two mixed-alias claimants as two unique claims, so the helper
 * expected the twin RETIRED while production — seeing one contested claim —
 * kept the `-sub-<toolUseId>` fallback row. The fidelity check would then have
 * failed on a correct store, or passed over a regression, depending on which
 * spelling a harness emitted.
 *
 * No corpus dossier emits a `providerToolUseId` distinct from its transcript
 * id, which is exactly why this is asserted here against a real import rather
 * than left to the golden suites.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openTestDb } from "./agent-db-test-utils.js";
import { expectedSubagentRowIds } from "./golden/golden-layer2-agent-ids.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "aliasclaim";
const TRANSCRIPT_TOOL_USE_ID = "toolu_transcript_1";
const PROVIDER_TOOL_USE_ID = "toolu_provider_1";
const CLAIMANT_A = "agent-alias1";
const CLAIMANT_B = "agent-alias2";

/**
 * One delegation carrying BOTH id forms, contested by two children that each
 * recorded a different one.
 */
function mixedAliasSession() {
  return makePopulatedSession({
    sessionId: SESSION_ID,
    subagents: [
      {
        id: CLAIMANT_A,
        name: `subagent ${CLAIMANT_A}`,
        type: "general-purpose",
        task: "contested work",
        startedAt: "2026-06-07T10:00:30.000Z",
        endedAt: "2026-06-07T10:00:40.000Z",
        metadata: { spawnedByToolUseId: TRANSCRIPT_TOOL_USE_ID },
      },
      {
        id: CLAIMANT_B,
        name: `subagent ${CLAIMANT_B}`,
        type: "general-purpose",
        task: "contested work",
        startedAt: "2026-06-07T10:00:30.000Z",
        endedAt: "2026-06-07T10:00:40.000Z",
        metadata: { spawnedByToolUseId: PROVIDER_TOOL_USE_ID },
      },
    ],
    toolUses: [
      {
        name: "Agent",
        timestamp: "2026-06-07T10:00:30.000Z",
        id: TRANSCRIPT_TOOL_USE_ID,
        providerToolUseId: PROVIDER_TOOL_USE_ID,
        input: { prompt: "work", subagent_type: "general-purpose" },
        resultTimestamp: "2026-06-07T10:00:40.000Z",
      },
    ],
  });
}

test("mixed-alias duplicate claims: the re-derivation matches the rows the store actually writes", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5105-alias-"));
  const db = await openTestDb(dir);
  try {
    const session = mixedAliasSession();
    const result = await db.importer.importSession(session, "claude");
    assert.equal(result.incomplete, undefined);

    const storedIds = (
      await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
        SESSION_ID
      )
    ).map((row) => row.id);

    assert.ok(
      storedIds.includes(`${SESSION_ID}-sub-${TRANSCRIPT_TOOL_USE_ID}`),
      "two children naming ONE delegation through different id forms is still an ambiguous claim, so the fallback row must survive"
    );
    assert.deepEqual(expectedSubagentRowIds(session, SESSION_ID), storedIds);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
