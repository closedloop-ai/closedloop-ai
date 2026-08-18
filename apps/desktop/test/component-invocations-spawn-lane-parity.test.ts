/**
 * @file component-invocations-spawn-lane-parity.test.ts
 * @description ISS-5099 regression: the invocation lane must derive
 * delegation↔subagent pairing from the same exact-claim correlation the
 * `agents` write lane uses (`buildSubagentDedupIndex`), not re-derive it with
 * greedy ordered fuzzy tiers.
 *
 * Repro shape (verified 2026-08-04 against the real store): one session, two
 * `Agent` tool uses, one parser subagent whose `metadata.spawnedByToolUseId`
 * names the SECOND, same `subagent_type`. Before the fix, the first tool use
 * greedily claimed the subagent through the type tier, so the second — the one
 * the subagent exactly claims — fell through and synthesized
 * `agent_id = <session>-sub-<toolUseId>`, precisely the fallback `agents` row
 * the ISS-4592 twin retirement no longer writes → FK 787, the whole
 * `component_invocations` group rolled back, and the session looped on
 * `incomplete`. Since ISS-5098 (#4355) the writer nulls the dangling reference
 * instead, so the failure shape became silent attribution loss — which is why
 * this test asserts the exact pairing, not just a completed import.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { openTestDb } from "./agent-db-test-utils.js";
import { makePopulatedSession } from "./normalized-session-test-utils.js";

const TU1 = "toolu_spawn_1";
const TU2 = "toolu_spawn_2";
const SESSION_ID = "spawnparity";
const CHILD = "agent-child01";
const PARSER_AGENT_ID = `${SESSION_ID}-parser-sub-${CHILD}`;
const TWIN_AGENT_ID = `${SESSION_ID}-sub-${TU1}`;

type InvocationRow = {
  external_invocation_id: string;
  agent_id: string | null;
  provider_tool_use_id: string | null;
};

test("two delegations, one parser subagent exactly claiming the SECOND: both lanes agree", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5099-parity-"));
  const logs: string[] = [];
  const db = await openTestDb(dir, { log: (message) => logs.push(message) });
  try {
    const result = await db.importer.importSession(
      makePopulatedSession({
        sessionId: SESSION_ID,
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
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined, "import must not be incomplete");

    const agentIds = (
      await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
        SESSION_ID
      )
    ).map((row) => row.id);
    // Write lane: parser row for the claimed delegation, twin only for the
    // unclaimed one — never a `-sub-<TU2>` row.
    assert.deepEqual(agentIds, [PARSER_AGENT_ID, TWIN_AGENT_ID]);

    const invocations = await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
      "SELECT external_invocation_id, agent_id, provider_tool_use_id FROM agent_component_invocations WHERE session_id = $1 AND external_invocation_id LIKE 'subagent:%' ORDER BY provider_tool_use_id",
      SESSION_ID
    );
    // One invocation row per delegation, each pointing at the agents row the
    // write lane actually produced for THAT delegation.
    assert.deepEqual(invocations, [
      {
        external_invocation_id: `subagent:${TU1}`,
        agent_id: TWIN_AGENT_ID,
        provider_tool_use_id: TU1,
      },
      {
        external_invocation_id: `subagent:${CHILD}`,
        agent_id: PARSER_AGENT_ID,
        provider_tool_use_id: TU2,
      },
    ]);

    // The ISS-5098 writer backstop must not have fired: pairing was correct at
    // derivation, so no reference was dropped (dropped = silent attribution
    // loss, the post-#4355 shape of this bug).
    const dropReports = logs.filter(
      (line) => line.includes("dropped") && line.includes("agent_id")
    );
    assert.deepEqual(dropReports, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("mixed-alias contest: the invocation row cannot name a contested child while the agents lane keeps the fallback", async () => {
  // ISS-5105 review (shafty023): tier 0 counted claimants by RAW provider id
  // while the dedup index canonicalizes through `delegationClaimKey`, so two
  // children claiming ONE tool use through DIFFERENT id forms read as a single
  // unopposed claimant at tier 0 and one of them won — while the `agents` lane,
  // seeing the same pair as ambiguous, kept the `-sub-<toolUseId>` fallback row
  // that carries the spawn event. Both consumers of one delegation must agree.
  const sessionId = "spawnparitymix";
  const callId = "call_mix1";
  const providerId = "toolu_mix1";
  const childProviderClaim = "agent-mixprov";
  const childTranscriptClaim = "agent-mixtranscript";
  const twinAgentId = `${sessionId}-sub-${callId}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5105-parity-mix-"));
  const db = await openTestDb(dir);
  try {
    const result = await db.importer.importSession(
      makePopulatedSession({
        sessionId,
        subagents: [
          {
            id: childProviderClaim,
            name: "claims the provider id",
            type: "general-purpose",
            task: "contested work",
            startedAt: "2026-06-07T10:00:30.000Z",
            endedAt: "2026-06-07T10:00:40.000Z",
            metadata: { spawnedByToolUseId: providerId },
          },
          {
            id: childTranscriptClaim,
            name: "claims the transcript id",
            type: "general-purpose",
            task: "contested work",
            startedAt: "2026-06-07T10:00:30.000Z",
            endedAt: "2026-06-07T10:00:40.000Z",
            metadata: { spawnedByToolUseId: callId },
          },
        ],
        toolUses: [
          {
            name: "Agent",
            timestamp: "2026-06-07T10:00:30.000Z",
            id: callId,
            providerToolUseId: providerId,
            input: { prompt: "contested", subagent_type: "general-purpose" },
            resultTimestamp: "2026-06-07T10:00:40.000Z",
          },
        ],
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined, "import must not be incomplete");

    const agentIds = (
      await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
        sessionId
      )
    ).map((row) => row.id);
    assert.ok(
      agentIds.includes(twinAgentId),
      "the agents lane keeps the fallback row for a contested delegation"
    );

    const contested = await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
      "SELECT external_invocation_id, agent_id, provider_tool_use_id FROM agent_component_invocations WHERE session_id = $1 AND provider_tool_use_id = $2 AND external_invocation_id LIKE 'subagent:%'",
      sessionId,
      providerId
    );
    // The delegation's own invocation lands on the SAME row the spawn event
    // did, never on either contesting child.
    assert.deepEqual(contested, [
      {
        external_invocation_id: `subagent:${providerId}`,
        agent_id: twinAgentId,
        provider_tool_use_id: providerId,
      },
    ]);

    const contestedAgentIds = [
      `${sessionId}-parser-sub-${childProviderClaim}`,
      `${sessionId}-parser-sub-${childTranscriptClaim}`,
    ];
    const misattributed = await db.prisma.client.$queryRawUnsafe<
      InvocationRow[]
    >(
      "SELECT external_invocation_id, agent_id, provider_tool_use_id FROM agent_component_invocations WHERE session_id = $1 AND provider_tool_use_id IS NOT NULL AND agent_id IN ($2, $3)",
      sessionId,
      contestedAgentIds[0],
      contestedAgentIds[1]
    );
    assert.deepEqual(
      misattributed,
      [],
      "no delegation-anchored invocation may point at a contested child"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("provider-keyed claim: both lanes honor providerToolUseId when it differs from the transcript id", async () => {
  // ISS-5099 review: the pre-pass, the tier-0 check, write-core's twin
  // retirement, and the emitted row all key the claim on
  // `providerToolUseId ?? toolUse.id` (`delegationClaimKey`). No parser
  // populates `providerToolUseId` today, so this pins the contract for the
  // first harness that does: the subagent claims the PROVIDER id of the
  // SECOND delegation, and both lanes must still agree.
  const sessionId = "spawnparityprov";
  const callId1 = "call_x1";
  const callId2 = "call_x2";
  const prov1 = "toolu_prov_1";
  const prov2 = "toolu_prov_2";
  const child = "agent-child02";
  const parserAgentId = `${sessionId}-parser-sub-${child}`;
  const twinAgentId = `${sessionId}-sub-${callId1}`;
  const dir = await mkdtemp(path.join(os.tmpdir(), "iss5099-parity-prov-"));
  const logs: string[] = [];
  const db = await openTestDb(dir, { log: (message) => logs.push(message) });
  try {
    const result = await db.importer.importSession(
      makePopulatedSession({
        sessionId,
        subagents: [
          {
            id: child,
            name: "second delegation",
            type: "general-purpose",
            task: "second delegation",
            startedAt: "2026-06-07T10:00:30.000Z",
            endedAt: "2026-06-07T10:00:40.000Z",
            metadata: { spawnedByToolUseId: prov2 },
          },
        ],
        toolUses: [
          {
            name: "Agent",
            timestamp: "2026-06-07T10:00:10.000Z",
            id: callId1,
            providerToolUseId: prov1,
            input: { prompt: "first", subagent_type: "general-purpose" },
            resultTimestamp: "2026-06-07T10:00:35.000Z",
          },
          {
            name: "Agent",
            timestamp: "2026-06-07T10:00:30.000Z",
            id: callId2,
            providerToolUseId: prov2,
            input: { prompt: "second", subagent_type: "general-purpose" },
            resultTimestamp: "2026-06-07T10:00:40.000Z",
          },
        ],
      }),
      "claude"
    );
    assert.equal(result.incomplete, undefined, "import must not be incomplete");

    const agentIds = (
      await db.prisma.client.$queryRawUnsafe<{ id: string }[]>(
        "SELECT id FROM agents WHERE session_id = $1 AND type = 'subagent' ORDER BY id",
        sessionId
      )
    ).map((row) => row.id);
    // Write lane: the provider-keyed claim retires the SECOND delegation's
    // twin; only the unclaimed FIRST delegation mints one.
    assert.deepEqual(agentIds, [parserAgentId, twinAgentId]);

    const invocations = await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
      "SELECT external_invocation_id, agent_id, provider_tool_use_id FROM agent_component_invocations WHERE session_id = $1 AND external_invocation_id LIKE 'subagent:%' ORDER BY provider_tool_use_id",
      sessionId
    );
    assert.deepEqual(invocations, [
      {
        external_invocation_id: `subagent:${prov1}`,
        agent_id: twinAgentId,
        provider_tool_use_id: prov1,
      },
      {
        external_invocation_id: `subagent:${child}`,
        agent_id: parserAgentId,
        provider_tool_use_id: prov2,
      },
    ]);

    const dropReports = logs.filter(
      (line) => line.includes("dropped") && line.includes("agent_id")
    );
    assert.deepEqual(dropReports, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
