/**
 * @file data-revision-spawn-mispair-rebuild.test.ts
 * @description ISS-5099 revision witness — a session SEALED at the pre-fix
 * revision with the delegation mispair its changelog entry describes must
 * re-derive CORRECT pairing when the DATA_REVISION rebuild re-parses it.
 *
 * The sealed shape is what the pre-fix derivation actually persisted (verified
 * against the repro in `component-invocations-spawn-lane-parity.test.ts` run on
 * pre-fix code): the earlier same-type delegation TU1 greedily claimed the
 * parser subagent through the fuzzy type tier (cross-paired row: parser agent +
 * `provider_tool_use_id` TU1), and the exactly-claiming TU2 synthesized the
 * retired `-sub-<TU2>` agent id, nulled by the ISS-5098 writer backstop. This
 * test seeds exactly that stored state, stamps the pre-fix revision, drives the
 * REAL `runDataRevisionRebuild` (production `openSqliteAgentDatabase`, no
 * Electron), and asserts the rows converge on the exact-claim pairing and the
 * session seals at the current DATA_REVISION. No golden oracle files are
 * involved — the fixture is synthetic.
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

/** The revision the mispair could last have been sealed under (pre-ISS-5099). */
const SEALED_AT_REVISION = 68;
const SID = "iss5099-sealed-mispair";
const TU1 = "toolu_sealed_1";
const TU2 = "toolu_sealed_2";
const CHILD = "agent-childseal";
const PARSER_AGENT_ID = `${SID}-parser-sub-${CHILD}`;
const TWIN_AGENT_ID = `${SID}-sub-${TU1}`;

type InvocationRow = {
  external_invocation_id: string;
  agent_id: string | null;
  provider_tool_use_id: string | null;
};

function repro() {
  return makePopulatedSession({
    sessionId: SID,
    subagents: [
      {
        id: CHILD,
        name: "second delegation",
        type: "general-purpose",
        task: "second delegation",
        startedAt: "2026-06-07T10:00:30.000Z",
        endedAt: "2026-06-07T10:00:40.000Z",
        metadata: { spawnedByToolUseId: TU2 },
      },
    ],
    toolUses: [
      {
        name: "Agent",
        timestamp: "2026-06-07T10:00:10.000Z",
        id: TU1,
        input: { prompt: "first", subagent_type: "general-purpose" },
        resultTimestamp: "2026-06-07T10:00:35.000Z",
      },
      {
        name: "Agent",
        timestamp: "2026-06-07T10:00:30.000Z",
        id: TU2,
        input: { prompt: "second", subagent_type: "general-purpose" },
        resultTimestamp: "2026-06-07T10:00:40.000Z",
      },
    ],
  });
}

test("a session sealed at the pre-fix revision with the mispair re-derives correct pairing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5099-sealed-"));
  const db = await openTestDb(dir);
  try {
    const session = repro();
    await db.importer.importSession(session, "claude");

    await seedPreFixMispair(db);
    await db.run(
      "UPDATE sessions SET data_revision = $1, status = 'inactive' WHERE id = $2",
      SEALED_AT_REVISION,
      SID
    );
    assert.deepEqual(
      await subagentInvocations(db),
      [
        {
          external_invocation_id: `subagent:${CHILD}`,
          agent_id: PARSER_AGENT_ID,
          provider_tool_use_id: TU1,
        },
        {
          external_invocation_id: `subagent:${TU2}`,
          agent_id: null,
          provider_tool_use_id: TU2,
        },
      ],
      "precondition: the sealed pre-fix mispair is in place"
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

    // The exact claim wins: the parser agent carries TU2, TU1 keeps its twin.
    // The stale `subagent:<TU2>` null-agent row is gone.
    assert.deepEqual(await subagentInvocations(db), [
      {
        external_invocation_id: `subagent:${CHILD}`,
        agent_id: PARSER_AGENT_ID,
        provider_tool_use_id: TU2,
      },
      {
        external_invocation_id: `subagent:${TU1}`,
        agent_id: TWIN_AGENT_ID,
        provider_tool_use_id: TU1,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

async function subagentInvocations(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<InvocationRow[]> {
  return await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
    `SELECT external_invocation_id, agent_id, provider_tool_use_id
       FROM agent_component_invocations
      WHERE session_id = $1 AND external_invocation_id LIKE 'subagent:%'
      ORDER BY external_invocation_id`,
    SID
  );
}

/**
 * Rewrite this session's invocation rows into the state the PRE-fix derivation
 * sealed: the parser-agent row cross-paired to TU1, and TU2's row carrying the
 * nulled synthesized reference (ISS-5098 backstop shape).
 *
 * The pre-fix TU2 candidate anchored on the SYNTHESIZED `-sub-<TU2>` agent id
 * (no such `agents` row — that is the FK-787 shape), so the seeded row carries
 * that anchor too, not the imported row's real twin anchor.
 */
async function seedPreFixMispair(
  db: Awaited<ReturnType<typeof openTestDb>>
): Promise<void> {
  await db.run(
    `UPDATE agent_component_invocations
        SET provider_tool_use_id = $1
      WHERE session_id = $2 AND external_invocation_id = $3`,
    TU1,
    SID,
    `subagent:${CHILD}`
  );
  await db.run(
    `UPDATE agent_component_invocations
        SET external_invocation_id = $1, provider_tool_use_id = $2,
            agent_id = NULL, anchor_value = $3
      WHERE session_id = $4 AND external_invocation_id = $5`,
    `subagent:${TU2}`,
    TU2,
    `${SID}-sub-${TU2}`,
    SID,
    `subagent:${TU1}`
  );
}

test("the missing-source bridge repairs the mispair instead of sealing it", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5099-nosource-"));
  const db = await openTestDb(dir);
  try {
    await db.importer.importSession(repro(), "claude");
    await seedPreFixMispair(db);
    await db.run(
      "UPDATE sessions SET data_revision = $1, status = 'inactive' WHERE id = $2",
      SEALED_AT_REVISION,
      SID
    );
    assert.equal(
      (await subagentInvocations(db)).find(
        (row) => row.external_invocation_id === `subagent:${CHILD}`
      )?.provider_tool_use_id,
      TU1,
      "precondition: the parser row is cross-paired to the WRONG delegation"
    );

    // No sources: the transcript is gone, so the rebuild can only take the
    // stored-row bridge — the path that used to seal the bad state.
    const result = await runDataRevisionRebuild({
      collectors: [fakeCollector("claude", { sources: [] })],
      db,
      useStoredComponentInvocationRebuild: true,
    });
    assert.equal(result.missingSource, 1, "the bridge, not a reparse, ran");

    const paired = await subagentInvocations(db);
    assert.equal(
      paired.find((row) => row.agent_id === PARSER_AGENT_ID)
        ?.provider_tool_use_id,
      TU2,
      "the durable spawn event re-derived the delegation the subagent claimed"
    );
    assert.ok(
      paired.some(
        (row) =>
          row.agent_id === TWIN_AGENT_ID && row.provider_tool_use_id === TU1
      ),
      "the unclaimed delegation keeps its own twin row"
    );

    const revisionRows = await db.prisma.client.$queryRawUnsafe<
      { data_revision: number | bigint }[]
    >("SELECT data_revision FROM sessions WHERE id = $1", SID);
    assert.equal(
      Number(revisionRows[0]?.data_revision),
      DATA_REVISION,
      "sealing is honest: the pairing was corrected before the stamp"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
