/**
 * @file data-revision-contested-claim-rebuild.test.ts
 * @description ISS-5105 revision witness — a session SEALED at revision 77 with
 * the contested-claim attribution its changelog entry describes must re-derive
 * onto the fallback row when the DATA_REVISION rebuild re-parses it.
 *
 * The sealed shape is what the pre-fix derivation persisted: tier 0 counted
 * claimants by RAW provider id, so of two children contesting ONE delegation
 * through different id forms only the provider-form claimant matched, read as
 * unopposed, and took the invocation — while the `agents` lane, which
 * canonicalizes both through `delegationClaimKey`, saw the pair as ambiguous and
 * kept the `-sub-<toolUseId>` fallback row the spawn event anchors to. This test
 * seeds that stored state, stamps revision 77, drives the REAL
 * `runDataRevisionRebuild` (production `openSqliteAgentDatabase`, no Electron),
 * and asserts the invocation moves off the contested child and the session seals
 * at the current DATA_REVISION. No golden oracle files are involved — the
 * fixture is synthetic.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { DATA_REVISION } from "../src/main/collectors/engine/data-revision.js";
import { runDataRevisionRebuild } from "../src/main/collectors/engine/data-revision-rebuild.js";
import { openTestDb } from "./agent-db-test-utils.js";
import {
  fakeCollector,
  makePopulatedSession,
} from "./normalized-session-test-utils.js";

/** The revision the contested attribution could last have been sealed under. */
const SEALED_AT_REVISION = 77;
const SID = "iss5105-sealed-contest";
const CALL_ID = "toolu_sealed_call";
const PROVIDER_ID = "toolu_sealed_prov";
const CHILD_PROVIDER_CLAIM = "agent-sealprov";
const CHILD_TRANSCRIPT_CLAIM = "agent-sealtranscript";
const WINNER_AGENT_ID = `${SID}-parser-sub-${CHILD_PROVIDER_CLAIM}`;
const FALLBACK_AGENT_ID = `${SID}-sub-${CALL_ID}`;

type InvocationRow = {
  external_invocation_id: string;
  agent_id: string | null;
  provider_tool_use_id: string | null;
};

function contestedChild(id: string, claim: string) {
  return {
    id,
    name: `contesting ${id}`,
    type: "general-purpose",
    task: "contested work",
    startedAt: "2026-06-07T10:00:30.000Z",
    endedAt: "2026-06-07T10:00:40.000Z",
    metadata: { spawnedByToolUseId: claim },
  };
}

function repro() {
  return makePopulatedSession({
    sessionId: SID,
    subagents: [
      contestedChild(CHILD_PROVIDER_CLAIM, PROVIDER_ID),
      contestedChild(CHILD_TRANSCRIPT_CLAIM, CALL_ID),
    ],
    toolUses: [
      {
        name: "Agent",
        timestamp: "2026-06-07T10:00:30.000Z",
        id: CALL_ID,
        providerToolUseId: PROVIDER_ID,
        input: { prompt: "contested", subagent_type: "general-purpose" },
        resultTimestamp: "2026-06-07T10:00:40.000Z",
      },
    ],
  });
}

test("a session sealed at revision 77 with the contested claim re-derives onto the fallback row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5105-sealed-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(repro(), "claude");
    await seedPreFixContestedClaim(db);
    await db.run(
      "UPDATE sessions SET data_revision = $1, status = 'inactive' WHERE id = $2",
      SEALED_AT_REVISION,
      SID
    );
    assert.deepEqual(
      await delegationAnchoredInvocations(db),
      [
        {
          external_invocation_id: `subagent:${CHILD_PROVIDER_CLAIM}`,
          agent_id: WINNER_AGENT_ID,
          provider_tool_use_id: PROVIDER_ID,
        },
      ],
      "precondition: the sealed state hands the delegation to a contested child"
    );

    const result = await runDataRevisionRebuild({
      collectors: [
        fakeCollector("claude", {
          sources: [`/fake/${SID}.jsonl`],
          parse: () => Promise.resolve([repro()]),
          sessionIdForSource: () => SID,
        }),
      ],
      db,
    });
    assert.equal(
      result.rebuilt,
      1,
      "the sealed session was selected and rebuilt"
    );

    const revisionRows = await db.prisma.client.$queryRawUnsafe<
      { data_revision: number | bigint }[]
    >("SELECT data_revision FROM sessions WHERE id = $1", SID);
    assert.equal(
      Number(revisionRows[0]?.data_revision),
      DATA_REVISION,
      "the rebuild sealed the session at the current revision"
    );

    // The delegation now anchors on the same row the agents lane kept, and no
    // contested child carries it.
    assert.deepEqual(await delegationAnchoredInvocations(db), [
      {
        external_invocation_id: `subagent:${PROVIDER_ID}`,
        agent_id: FALLBACK_AGENT_ID,
        provider_tool_use_id: PROVIDER_ID,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("a transcript-less session is still selected by the bump and seals on the fallback attribution", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5105-nosource-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(repro(), "claude");
    await seedPreFixContestedClaim(db);
    await db.run(
      "UPDATE sessions SET data_revision = $1, status = 'inactive' WHERE id = $2",
      SEALED_AT_REVISION,
      SID
    );

    // No sources: the transcript is gone, so the rebuild can only take the
    // stored-row bridge — the path that would otherwise seal the bad state.
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db,
      useStoredComponentInvocationRebuild: true,
    });
    assert.equal(result.missingSource, 1, "the bridge, not a reparse, ran");

    // What the bridge itself derives lands on the row the agents lane kept: it
    // reads the stored spawn event, which for a contested delegation anchors on
    // the fallback row, never on a claimant. It cannot rewrite the live path's
    // `subagent:<rawSubagentId>` rows — the bridge keys its own on the AGENT id,
    // a separate key space — so a transcript-less session keeps the stale row
    // beside the corrected one. Only a reparse fully converges it (test above).
    const contested = await delegationAnchoredInvocations(db);
    assert.ok(
      contested.some(
        (row) =>
          row.agent_id === FALLBACK_AGENT_ID &&
          row.provider_tool_use_id === PROVIDER_ID
      ),
      "the bridge derived the contested delegation onto the fallback agents row"
    );

    const revisionRows = await db.prisma.client.$queryRawUnsafe<
      { data_revision: number | bigint }[]
    >("SELECT data_revision FROM sessions WHERE id = $1", SID);
    assert.equal(
      Number(revisionRows[0]?.data_revision),
      DATA_REVISION,
      "sealing is honest: the attribution was corrected before the stamp"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/** Every subagent invocation that claims to speak for the delegation itself. */
async function delegationAnchoredInvocations(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<InvocationRow[]> {
  return await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
    `SELECT external_invocation_id, agent_id, provider_tool_use_id
       FROM agent_component_invocations
      WHERE session_id = $1 AND external_invocation_id LIKE 'subagent:%'
        AND provider_tool_use_id IS NOT NULL
      ORDER BY external_invocation_id`,
    SID
  );
}

/**
 * Rewrite this session's invocation rows into the state the PRE-fix derivation
 * sealed: the provider-form claimant won tier 0, so its row carries the
 * delegation and the delegation's own `subagent:<providerId>` row (the one
 * anchored on the fallback `agents` row) was never emitted.
 */
async function seedPreFixContestedClaim(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<void> {
  await db.run(
    `DELETE FROM agent_component_invocations
      WHERE session_id = $1 AND external_invocation_id = $2`,
    SID,
    `subagent:${PROVIDER_ID}`
  );
  await db.run(
    `UPDATE agent_component_invocations
        SET provider_tool_use_id = $1
      WHERE session_id = $2 AND external_invocation_id = $3`,
    PROVIDER_ID,
    SID,
    `subagent:${CHILD_PROVIDER_CLAIM}`
  );
}
