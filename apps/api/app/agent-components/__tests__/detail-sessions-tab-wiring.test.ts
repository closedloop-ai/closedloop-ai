/**
 * ISS-5464 (production wiring): the detail read actually ASKS for the bounded
 * `sessionsTab`. Without this, deleting the argument at the call site leaves the
 * bound's own suite green while the response goes back to shipping up to
 * `MAX_DETAIL_SESSION_IN_IDS` enriched session summaries.
 *
 * It also pins the two halves of the truncation contract that must not drift
 * apart: the payload bound, and the branch-attribution id set — which is
 * deliberately NOT reduced, because `usageSessions` resolves session-level
 * branch names through it for every session, not just the rendered ones.
 */
import { AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS } from "@repo/api/src/types/agent-component";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  listByArtifactIds: vi.fn(),
  artifactLinkFindMany: vi.fn(),
}));

vi.mock("../../agent-sessions/service", () => ({
  agentSessionsService: { listByArtifactIds: mocks.listByArtifactIds },
}));

import { resolveDetailSessionTabs } from "../service/detail-session-tabs";

const ORGANIZATION_ID = "org-wiring";

/** More sessions than the payload bound, so the bound is observable. */
const SESSION_COUNT = 1218;

function db() {
  return {
    artifactLink: { findMany: mocks.artifactLinkFindMany },
  } as unknown as Parameters<typeof resolveDetailSessionTabs>[0];
}

function invCountBySession(): Map<string, number> {
  return new Map(
    Array.from({ length: SESSION_COUNT }, (_, i) => [`session-${i + 1}`, 3])
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.artifactLinkFindMany.mockResolvedValue([]);
  mocks.listByArtifactIds.mockResolvedValue([]);
});

describe("ISS-5464 detail sessionsTab wiring", () => {
  it("requests the sessions tab under the payload bound", async () => {
    await resolveDetailSessionTabs(db(), ORGANIZATION_ID, invCountBySession());

    expect(mocks.listByArtifactIds).toHaveBeenCalledWith(
      ORGANIZATION_ID,
      expect.any(Array),
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
  });

  it("does not narrow branch attribution to the payload bound", async () => {
    await resolveDetailSessionTabs(db(), ORGANIZATION_ID, invCountBySession());

    // Branch attribution feeds `usageSessions`, which stays per-(session,
    // branch) for EVERY session — not only the rendered ones. Reducing this id
    // set to the payload bound would silently strip branch names off the
    // majority of `usageSessions` rows: a correctness regression traded for
    // bytes we do not need to save here.
    const attributionIds = mocks.artifactLinkFindMany.mock.calls[0][0].where
      .sourceId.in as string[];
    expect(attributionIds.length).toBeGreaterThan(
      AGENT_COMPONENT_DETAIL_SESSIONS_TAB_MAX_ROWS
    );
  });

  it("still emits one usageSessions row per session past the payload bound", async () => {
    const { usageSessions } = await resolveDetailSessionTabs(
      db(),
      ORGANIZATION_ID,
      invCountBySession()
    );

    // The bound is on the SUMMARIES, not on the truth: per-session usage
    // attribution is unchanged.
    expect(usageSessions).toHaveLength(SESSION_COUNT);
  });
});
