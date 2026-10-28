/**
 * ISS-10332 / PLN-2086 Milestone 3 steps 17-19: the desktop sync wire contract
 * carries a locally set `priority` on the session and on its branch ref.
 *
 * DB-free — the ingress contract only, in both version-skew directions: an
 * OLDER desktop omits the field and must still be accepted with nothing
 * claimed, and a NEWER desktop's payload must not be rejected — neither by this
 * cloud (an unknown member degrades to absent) nor by the cloud that predates
 * the field (modelled as this schema without the key, which strips it). The
 * seed-if-unset write is proven against Postgres in
 * `__tests__/integration/iss10332-session-branch-priority.integration.test.ts`.
 */
import { AgentSessionSyncMode } from "@repo/api/src/types/agent-session";
import { Priority } from "@repo/api/src/types/common";
import {
  ArtifactRefRelation,
  ArtifactRefTargetKind,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it } from "vitest";
import {
  parseDesktopAgentSessionsPayload,
  syncedAgentSessionSchema,
} from "./desktop-agent-sessions-schema";

const SCHEMA_VERSION = 2 as const;

function buildSession(
  extras: Record<string, unknown>,
  refExtras: Record<string, unknown> = {}
): Record<string, unknown> {
  return {
    externalSessionId: "sess-1",
    name: "collector-derived",
    status: "active",
    startedAt: "2026-09-22T10:00:00.000Z",
    updatedAt: "2026-09-22T11:00:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
    artifactRefs: [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: "owner/repo",
        branchName: "feat/x",
        method: "git_push",
        relation: ArtifactRefRelation.Created,
        ...refExtras,
      },
    ],
    ...extras,
  };
}

function parseSession(
  extras: Record<string, unknown>,
  refExtras: Record<string, unknown> = {}
) {
  const parsed = parseDesktopAgentSessionsPayload({
    schemaVersion: SCHEMA_VERSION,
    batchId: "00000000-0000-4000-8000-000000000001",
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: 1,
    sessions: [buildSession(extras, refExtras)],
  });
  if (!parsed.ok) {
    throw new Error(`payload rejected: ${parsed.reason}`);
  }
  const [session] = parsed.payload.sessions;
  const ref = session?.artifactRefs?.[0];
  if (!session || ref?.kind !== ArtifactRefTargetKind.Branch) {
    throw new Error("expected one session carrying one branch ref");
  }
  return { session, ref };
}

describe("desktop sync schema — priority (ISS-10332)", () => {
  it("round-trips a desktop-set priority on the session and its branch ref", () => {
    const { session, ref } = parseSession(
      { priority: Priority.Urgent },
      { priority: Priority.Low }
    );
    expect(session.priority).toBe(Priority.Urgent);
    expect(ref.priority).toBe(Priority.Low);
  });

  it("accepts an older desktop's payload, which omits both, and claims nothing", () => {
    const { session, ref } = parseSession({});
    expect(session.priority).toBeUndefined();
    expect(ref.priority).toBeUndefined();
  });

  it("drops a value outside the vocabulary rather than rejecting the session", () => {
    for (const unknown of ["CRITICAL", "high", 3, null, {}]) {
      const { session, ref } = parseSession(
        { priority: unknown },
        { priority: unknown }
      );
      expect(session.priority).toBeUndefined();
      expect(ref.priority).toBeUndefined();
    }
  });

  it("lets a cloud that predates the field accept a newer desktop's session", () => {
    // That cloud's session schema is this one without the key. It is not
    // `.strict()`, so the additive field is stripped — never a rejection that
    // would park the whole batch behind a field it has no use for.
    const predating = syncedAgentSessionSchema.omit({ priority: true });
    const parsed = predating.safeParse(
      buildSession({ priority: Priority.High }, { priority: Priority.High })
    );
    expect(parsed.success).toBe(true);
    expect(parsed.success && "priority" in parsed.data).toBe(false);
  });
});
