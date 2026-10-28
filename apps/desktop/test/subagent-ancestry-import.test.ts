/**
 * @file subagent-ancestry-import.test.ts
 * @description ISS-10714: pins what the WRITE LANES do with the reconstructed
 * spawn tree — `agents.parent_agent_id` following the real nesting, the
 * invocation row agreeing with it, and the ancestry facts that keep an
 * unreconstructable parent from reading as a main-agent one.
 *
 * The resolver being right proves nothing if the write lanes keep their
 * `mainId` fallback, so these drive the production derivation and the real
 * importer rather than the resolver in isolation.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { describe, expect, test } from "vitest";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { deriveAgentComponentInvocationCandidates } from "../src/main/database/component-invocations.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import { SubagentParentSource } from "../src/main/database/subagent-ancestry.js";
import { makeSession } from "./normalized-session-test-utils.js";

const SESSION_ID = "ancestry-import";
const NOW = "2026-09-01T12:00:00.000Z";
const MAIN_AGENT_ID = `${SESSION_ID}-main`;
const DB_TEST_TIMEOUT_MS = 120_000;

/**
 * main -> outer -> inner, plus `stray`, which records no spawn evidence at all.
 * The `Agent` call that spawned `inner` lives on OUTER's tool uses — that
 * placement is the only thing naming outer as inner's caller, so a resolver
 * that ignored it would flatten `inner` onto the main agent.
 */
function nestedSession(): NormalizedSession {
  return makeSession({
    sessionId: SESSION_ID,
    startedAt: NOW,
    endedAt: "2026-09-01T12:10:00.000Z",
    toolUses: [
      {
        name: "Agent",
        id: "toolu-outer",
        providerToolUseId: "toolu-outer",
        timestamp: "2026-09-01T12:01:00.000Z",
        input: { description: "outer" },
      },
    ],
    subagents: [
      {
        id: "agent-outer",
        name: "Outer Agent",
        startedAt: "2026-09-01T12:01:00.000Z",
        endedAt: "2026-09-01T12:05:00.000Z",
        status: "completed",
        metadata: { spawnedByToolUseId: "toolu-outer" },
        toolUses: [
          {
            name: "Agent",
            id: "toolu-inner",
            providerToolUseId: "toolu-inner",
            timestamp: "2026-09-01T12:02:00.000Z",
            input: { description: "inner" },
          },
        ],
      },
      {
        id: "agent-inner",
        name: "Inner Agent",
        startedAt: "2026-09-01T12:02:00.000Z",
        endedAt: "2026-09-01T12:04:00.000Z",
        status: "completed",
        metadata: { spawnedByToolUseId: "toolu-inner" },
        toolUses: [],
      },
      {
        id: "agent-stray",
        name: "Stray Agent",
        startedAt: "2026-09-01T12:06:00.000Z",
        endedAt: "2026-09-01T12:07:00.000Z",
        status: "completed",
        toolUses: [],
      },
    ],
  });
}

describe("ISS-10714 write lanes carry the reconstructed ancestry", () => {
  test("the invocation candidates nest, and both parent fields agree", () => {
    const candidates = deriveAgentComponentInvocationCandidates(
      nestedSession(),
      MAIN_AGENT_ID,
      NOW
    );
    const byExternalId = new Map(
      candidates.map((candidate) => [candidate.externalInvocationId, candidate])
    );
    const outer = byExternalId.get("subagent:agent-outer");
    const inner = byExternalId.get("subagent:agent-inner");
    const stray = byExternalId.get("subagent:agent-stray");
    expect(outer).toBeTruthy();
    expect(inner).toBeTruthy();
    expect(stray).toBeTruthy();

    // The whole point: `inner` hangs off `outer`, not off the main agent, and
    // the agent-grained and invocation-grained parents name the same call.
    expect(inner?.parentAgentId).toBe(outer?.agentId);
    expect(inner?.parentAgentId).not.toBe(MAIN_AGENT_ID);
    expect(inner?.evidencePointer?.parentExternalInvocationId).toBe(
      "subagent:agent-outer"
    );

    expect(outer?.parentAgentId).toBe(MAIN_AGENT_ID);
    expect(outer?.evidencePointer?.parentExternalInvocationId).toBeUndefined();
    // No evidence: the column keeps its main-agent fallback (several rollups
    // read a NULL parent as a session root) and claims no parent invocation.
    expect(stray?.parentAgentId).toBe(MAIN_AGENT_ID);
    expect(stray?.evidencePointer?.parentExternalInvocationId).toBeUndefined();
  });

  test("a delegation on the main transcript that names its issuer also nests", () => {
    // The OTHER subagent-candidate branch: a subagent represented by a spawn
    // tool use is emitted by `spawnedSubagentCandidate`, not by
    // `parserSubagentCandidate`. A nested delegation whose `Agent` call sits on
    // `session.toolUses` carrying `subagentId` lands there, and leaving it on
    // the main-agent default would disagree with the `agents` row.
    const session = makeSession({
      sessionId: SESSION_ID,
      startedAt: NOW,
      endedAt: "2026-09-01T12:10:00.000Z",
      toolUses: [
        {
          name: "Agent",
          id: "toolu-lead",
          providerToolUseId: "toolu-lead",
          timestamp: "2026-09-01T12:01:00.000Z",
          input: { description: "lead" },
        },
        {
          name: "Agent",
          id: "toolu-nested",
          providerToolUseId: "toolu-nested",
          timestamp: "2026-09-01T12:02:00.000Z",
          subagentId: "agent-lead",
          input: { description: "nested" },
        },
      ],
      subagents: [
        {
          id: "agent-lead",
          name: "Lead Agent",
          startedAt: "2026-09-01T12:01:00.000Z",
          endedAt: "2026-09-01T12:05:00.000Z",
          status: "completed",
          metadata: { spawnedByToolUseId: "toolu-lead" },
          toolUses: [],
        },
        {
          id: "agent-nested",
          name: "Nested Agent",
          startedAt: "2026-09-01T12:02:00.000Z",
          endedAt: "2026-09-01T12:04:00.000Z",
          status: "completed",
          metadata: { spawnedByToolUseId: "toolu-nested" },
          toolUses: [],
        },
      ],
    }) as NormalizedSession;

    const candidates = deriveAgentComponentInvocationCandidates(
      session,
      MAIN_AGENT_ID,
      NOW
    );
    const byExternalId = new Map(
      candidates.map((candidate) => [candidate.externalInvocationId, candidate])
    );
    const lead = byExternalId.get("subagent:agent-lead");
    const nested = byExternalId.get("subagent:agent-nested");
    expect(lead).toBeTruthy();
    expect(nested).toBeTruthy();

    expect(nested?.parentAgentId).toBe(lead?.agentId);
    expect(nested?.parentAgentId).not.toBe(MAIN_AGENT_ID);
    expect(nested?.evidencePointer?.parentExternalInvocationId).toBe(
      "subagent:agent-lead"
    );
    expect(lead?.parentAgentId).toBe(MAIN_AGENT_ID);
  });

  test(
    "the imported agents rows nest and distinguish a fallback parent",
    async () => {
      const dir = await mkdtemp(path.join(os.tmpdir(), "ancestry-import-"));
      const db = await openSqliteAgentDatabase({
        dataDir: path.join(dir, "agent-dashboard.sqlite"),
        detectBillingMode: () => "metered_api",
        now: () => NOW,
      });
      try {
        await db.importer.importSession(nestedSession(), "claude");
        const agents = await db.agents.getBySession(SESSION_ID);
        const outer = agents.find((agent) => agent.name === "Outer Agent");
        const inner = agents.find((agent) => agent.name === "Inner Agent");
        const stray = agents.find((agent) => agent.name === "Stray Agent");
        expect(outer).toBeTruthy();
        expect(inner).toBeTruthy();
        expect(stray).toBeTruthy();

        expect(outer?.parentAgentId).toBe(MAIN_AGENT_ID);
        expect(inner?.parentAgentId).toBe(outer?.id);
        expect(inner?.parentAgentId).not.toBe(MAIN_AGENT_ID);

        expect(JSON.parse(outer?.metadata ?? "{}").ancestry).toEqual({
          parentSource: SubagentParentSource.SpawnToolUse,
          depth: 1,
        });
        expect(JSON.parse(inner?.metadata ?? "{}").ancestry).toEqual({
          parentSource: SubagentParentSource.SpawnToolUse,
          depth: 2,
        });
        // Same column value as `outer`, different fact — and the row says which,
        // asserting no depth rather than a confident 1.
        expect(stray?.parentAgentId).toBe(MAIN_AGENT_ID);
        expect(JSON.parse(stray?.metadata ?? "{}").ancestry).toEqual({
          parentSource: SubagentParentSource.NoEvidence,
        });
      } finally {
        await db.close();
        await rm(dir, { recursive: true, force: true });
      }
    },
    DB_TEST_TIMEOUT_MS
  );
});
