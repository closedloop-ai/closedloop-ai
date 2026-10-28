/**
 * ISS-12552: the desktop sync wire contract carries a
 * session's `operationEvidence`. DB-free, the ingress contract only, in both
 * version-skew directions: an older desktop omits it and claims nothing, and a
 * snapshot this API cannot parse is dropped to absent rather than rejecting
 * the session's sync.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { OperationKind } from "@repo/api/src/types/attribution-evidence";
import {
  OperationClaimSource,
  ToolResultState,
} from "@repo/api/src/types/operation-claims";
import { describe, expect, it } from "vitest";
import { parseDesktopAgentSessionsPayload } from "./desktop-agent-sessions-schema";

const EVIDENCE = {
  extractorVersion: 1,
  digest: "b".repeat(64),
  coverage: {
    harness: "codex",
    evidencePathSupported: true,
    closedloopMcpCalls: 1,
    shellCallsWithOperationIds: 0,
    directApiShellCommands: 0,
    unsupportedToolNames: {},
    claimsDroppedByCap: 0,
  },
  claims: [
    {
      claimKey: "codex:exec-1",
      source: OperationClaimSource.ClosedloopMcp,
      toolName: "update-document",
      operationKind: OperationKind.UpdateFields,
      resultState: ToolResultState.Present,
      operationIds: ["clop_01a14224-9b59-77ba-b518-16aaa9880991"],
    },
  ],
};

function parseSession(extras: Record<string, unknown>) {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: 2,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [
      {
        externalSessionId: "sess-1",
        status: "active",
        startedAt: "2026-10-16T10:00:00.000Z",
        updatedAt: "2026-10-16T11:00:00.000Z",
        agents: [],
        events: [],
        tokenUsageByModel: [],
        ...extras,
      },
    ],
  });
  if (!parsed.ok) {
    throw new Error(`payload rejected: ${parsed.reason}`);
  }
  const [session] = parsed.payload.sessions;
  if (!session) {
    throw new Error("expected one session");
  }
  return session;
}

describe("desktop sync schema, operationEvidence (ISS-12552)", () => {
  it("round-trips a desktop-sent snapshot", () => {
    expect(
      parseSession({ operationEvidence: EVIDENCE }).operationEvidence
    ).toEqual({ ...EVIDENCE, unparsedClaims: 0 });
  });

  it("accepts an older desktop's payload, which omits it, and claims nothing", () => {
    expect("operationEvidence" in parseSession({})).toBe(false);
  });

  it("drops a snapshot it cannot parse without rejecting the session", () => {
    const session = parseSession({
      operationEvidence: { ...EVIDENCE, digest: "not-a-digest" },
    });

    expect(session.operationEvidence).toBeUndefined();
    expect(session.externalSessionId).toBe("sess-1");
  });
});
