/**
 * ISS-5801: the branch cost fold must read the SAME 7-signal substantive
 * inventory as the Sessions surface. These cases pin the divergence the
 * cr-20461 impact review caught: an invocation-only (slash/skill/subagent/
 * hook) subscription session whose $0 is a covered figure on the Sessions
 * list must price identically here — and the contrast case pins that the
 * pricing comes from `componentInvocationCount`, not from subscription
 * billing alone. Kept out of `session-usage-window.test.ts`, which sits at
 * the noExcessiveLinesPerFile ceiling.
 */
import { BranchParticipationKind } from "@repo/api/src/types/branch";
import { SessionArtifactLinkKind } from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import type { LinkedSession } from "./session-usage-link-read";
import {
  getSessionUsageByBranch,
  type SessionUsageClient,
} from "./session-usage-window";

function invocationOnlySession(
  componentInvocationCount: number
): LinkedSession {
  return {
    artifactId: "session-1",
    externalSessionId: "session-1",
    harness: "claude",
    sessionStartedAt: new Date("2026-06-10T10:00:00.000Z"),
    sessionEndedAt: null,
    lastActivityAt: new Date("2026-06-10T10:00:00.000Z"),
    // A REPORTED subscription zero — a valid priced value, not a null unknown.
    estimatedCost: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    turns: null,
    toolUseCount: 0,
    componentInvocationCount,
    billingMode: "pro",
    ownerUserId: null,
  };
}

function makeDb(session: LinkedSession): SessionUsageClient {
  return {
    $queryRaw: vi.fn().mockResolvedValue([]),
    artifactLink: {
      findMany: vi.fn().mockResolvedValue([
        {
          targetId: "branch-1",
          sourceId: session.artifactId,
          branchParticipation: BranchParticipationKind.Wrote,
          metadata: { linkKind: SessionArtifactLinkKind.SessionBranch },
          source: { name: "Session", slug: "session", session },
        },
      ]),
    },
    agentSessionTokenEvent: {
      findMany: vi.fn().mockResolvedValue([]),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  } as unknown as SessionUsageClient;
}

describe("branch priced-cost fold × the invocation substantive signal (ISS-5801)", () => {
  it("prices an invocation-only subscription $0 like the Sessions surface", async () => {
    const usage = await getSessionUsageByBranch(
      makeDb(invocationOnlySession(2)),
      "org-1",
      ["branch-1"]
    );

    expect(usage.get("branch-1")?.hasPricedCost).toBe(true);
  });

  it("keeps the same subscription $0 row unpriced when no invocation exists", async () => {
    const usage = await getSessionUsageByBranch(
      makeDb(invocationOnlySession(0)),
      "org-1",
      ["branch-1"]
    );

    expect(usage.get("branch-1")?.hasPricedCost).toBe(false);
  });
});
