/**
 * Unit tests for the FEA-1684 cloud ingestion helpers.
 *
 * Coverage targets:
 *   1. parseDesktopAgentSessionsPayload — backward compat: payloads with and
 *      without artifactRefs / prRefs both parse correctly (AC 56).
 *   2. agentSessionsService.getArtifactSessionUsage — attribution query DTO
 *      shape, zero-sessions early return, byModel sort order (AC 65).
 *
 * The private helpers (resolveArtifactSlugMap, mergeArtifactRefsBySlug,
 * roleFromMethod, persistArtifactLinks, persistSessionPrArtifactLinks) are not
 * exported; their logic is validated in-package via the public API and through
 * the type tests in packages/api/src/types/session-artifact-link.test.ts.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";

// --- module-level mocks (must appear before service import) -----------------

vi.mock("@repo/database", () => ({
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
    SESSION: "SESSION",
  },
  Prisma: { DbNull: "DbNull" },
  GitHubInstallationStatus: { ACTIVE: "ACTIVE", SUSPENDED: "SUSPENDED" },
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Imports (after mocks)
// ---------------------------------------------------------------------------

import {
  AGENT_SESSION_SYNC_SCHEMA_VERSION,
  AgentSessionSyncMode,
} from "@repo/api/src/types/agent-session";
import {
  type ArtifactSessionUsageSummary,
  MAX_SYNCED_SESSION_PR_REFS,
  MAX_SYNCED_SESSION_PR_REFS_PRODUCER,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { persistSessionPrArtifactLinks } from "@/app/agent-sessions/service/artifact-links/pr-links";
import { parseDesktopAgentSessionsPayload } from "@/lib/desktop-agent-sessions-schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const SCHEMA_VER = AGENT_SESSION_SYNC_SCHEMA_VERSION;

/** Minimal valid session object (no FEA-1684 fields) */
function buildMinimalSession(id = "sess-1") {
  return {
    externalSessionId: id,
    status: "completed",
    harness: "claude",
    cwd: "/tmp",
    model: "claude-sonnet-4",
    startedAt: "2026-06-01T10:00:00.000Z",
    updatedAt: "2026-06-01T10:05:00.000Z",
    agents: [],
    events: [],
    tokenUsageByModel: [],
  };
}

/** Valid RFC 4122 v4 UUID for use in payloads. */
const TEST_BATCH_ID = "f47ac10b-58cc-4372-a567-0e02b2c3d479";

/** Minimal valid payload envelope */
function buildPayload(sessions: unknown[] = [buildMinimalSession()]) {
  return {
    schemaVersion: SCHEMA_VER,
    batchId: TEST_BATCH_ID,
    syncMode: AgentSessionSyncMode.Incremental,
    sessionCount: sessions.length,
    sessions,
  };
}

function getMockWithDb() {
  return withDb as unknown as ReturnType<typeof vi.fn> & {
    tx: ReturnType<typeof vi.fn>;
  };
}

// ---------------------------------------------------------------------------
// parseDesktopAgentSessionsPayload — backward compat (AC 56)
// ---------------------------------------------------------------------------

describe("parseDesktopAgentSessionsPayload — backward compatibility", () => {
  it("accepts a session with no artifactRefs and no prRefs", () => {
    const result = parseDesktopAgentSessionsPayload(buildPayload());
    expect(result.ok).toBe(true);
  });

  it("accepts a session with artifactRefs present", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "FEA-1684", isPrimary: true, method: "mcp_tool_call" },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs).toHaveLength(1);
  });

  it("accepts a session with prRefs present", () => {
    const session = {
      ...buildMinimalSession(),
      prRefs: [
        {
          repositoryFullName: "closedloop-ai/symphony-alpha",
          prNumber: 42,
          prUrl: "https://github.com/closedloop-ai/symphony-alpha/pull/42",
          relationType: SessionPrRelationType.Created,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.prRefs).toHaveLength(1);
  });

  it("accepts a session with both artifactRefs and prRefs", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "PLN-5", isPrimary: false, method: "slug_in_branch" },
      ],
      prRefs: [
        {
          repositoryFullName: "org/repo",
          prNumber: 1,
          prUrl: "https://github.com/org/repo/pull/1",
          relationType: SessionPrRelationType.Referenced,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(true);
  });

  it("returns ok=false when an artifactRef has an invalid slug", () => {
    const session = {
      ...buildMinimalSession(),
      artifactRefs: [
        { slug: "TASK-999", isPrimary: false, method: "slug_in_message" },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(false);
    // The first parse issue under sessions[*] maps to "session_invalid"
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe("session_invalid");
  });

  it("returns ok=false when a prRef has a non-positive prNumber (0)", () => {
    const session = {
      ...buildMinimalSession(),
      prRefs: [
        {
          repositoryFullName: "org/repo",
          prNumber: 0,
          prUrl: "https://github.com/org/repo/pull/0",
          relationType: SessionPrRelationType.Created,
        },
      ],
    };
    const result = parseDesktopAgentSessionsPayload(buildPayload([session]));
    expect(result.ok).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ISS-4445 (PR1/4 of PLN-1536): the cloud prRefs `.max()` cap was raised
// 100 → 500 so a large session keeps its real linked PRs. The raise must be
// additive/backward-compatible: an OLD desktop that still sends ≤100 prRefs
// must keep validating, and a NEW desktop that sends up to the raised cap must
// now be accepted (previously rejected at 100). Over the cap still rejects.
// ---------------------------------------------------------------------------

describe("prRefs cap (ISS-4445) — raised cap + version-skew backward compat", () => {
  function buildPrRefs(count: number, startNumber = 1) {
    return Array.from({ length: count }, (_, i) => ({
      repositoryFullName: "org/repo",
      prNumber: startNumber + i,
      prUrl: `https://github.com/org/repo/pull/${startNumber + i}`,
      relationType: SessionPrRelationType.Created,
    }));
  }

  // A real Desktop payload emits the SAME PR rows twice: the structured
  // `prRefs` (schema-capped by `.max(MAX_SYNCED_SESSION_PR_REFS)`) AND the
  // legacy `prs` summary array (`{ num, title, status }`), which the cloud
  // validates independently with its own `.max(MAX_SYNCED_SESSION_PR_REFS)`.
  // Building both here means this test fails if EITHER cap drifts.
  function buildPrs(count: number, startNumber = 1) {
    return Array.from({ length: count }, (_, i) => ({
      num: startNumber + i,
      title: `PR ${startNumber + i}`,
      status: "open",
    }));
  }

  // Production-shaped session: both PR arrays present at the same count, as a
  // new Desktop actually emits them.
  function parsePrRefs(count: number) {
    const session = {
      ...buildMinimalSession(),
      prRefs: buildPrRefs(count),
      prs: buildPrs(count),
    };
    return parseDesktopAgentSessionsPayload(buildPayload([session]));
  }

  it("the SSOT validator cap is 500 (raised from 100)", () => {
    // Guards against an accidental revert of the receive-side cap the cloud
    // wire-schema validator derives from.
    expect(MAX_SYNCED_SESSION_PR_REFS).toBe(500);
  });

  it("the desktop PRODUCER cap stays 100, at or below the validator cap (ISS-4445 version-skew)", () => {
    // Backward-compat invariant: the desktop must never emit more PR refs than an
    // OLD cloud (still `.max(100)`) accepts, or the old server rejects the whole
    // batch during a staged rollout. PR1 keeps the producer at 100 while the
    // validator rises to 500; the producer cap must always be ≤ the validator cap
    // so a new desktop's payload validates against BOTH old and new cloud.
    expect(MAX_SYNCED_SESSION_PR_REFS_PRODUCER).toBe(100);
    expect(MAX_SYNCED_SESSION_PR_REFS_PRODUCER).toBeLessThanOrEqual(
      MAX_SYNCED_SESSION_PR_REFS
    );
  });

  it("accepts an old desktop payload with ≤100 prRefs/prs (version-skew, unchanged)", () => {
    const result = parsePrRefs(100);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.prRefs).toHaveLength(100);
    // The legacy `prs` array survives the same-shaped boundary too.
    expect(result.payload.sessions[0]?.prs).toHaveLength(100);
  });

  it("accepts a new desktop payload with >100 prRefs/prs up to the raised cap", () => {
    // 101 previously failed the old `.max(100)`; the point of the raise. Both
    // arrays carry 101 rows, so this fails if EITHER the `prRefs` or the `prs`
    // validator cap silently reverts to 100.
    const overOldCap = parsePrRefs(101);
    expect(overOldCap.ok).toBe(true);
    if (!overOldCap.ok) {
      return;
    }
    expect(overOldCap.payload.sessions[0]?.prRefs).toHaveLength(101);
    expect(overOldCap.payload.sessions[0]?.prs).toHaveLength(101);

    const atNewCap = parsePrRefs(MAX_SYNCED_SESSION_PR_REFS);
    expect(atNewCap.ok).toBe(true);
    if (!atNewCap.ok) {
      return;
    }
    expect(atNewCap.payload.sessions[0]?.prRefs).toHaveLength(
      MAX_SYNCED_SESSION_PR_REFS
    );
    expect(atNewCap.payload.sessions[0]?.prs).toHaveLength(
      MAX_SYNCED_SESSION_PR_REFS
    );
  });

  it("rejects a payload that exceeds the raised cap", () => {
    const result = parsePrRefs(MAX_SYNCED_SESSION_PR_REFS + 1);
    expect(result.ok).toBe(false);
  });

  it("rejects when prRefs alone exceeds the raised cap (prs at cap)", () => {
    // Each PR array is validated independently; an over-cap `prRefs` must
    // reject the batch even when `prs` is within bounds.
    const session = {
      ...buildMinimalSession(),
      prRefs: buildPrRefs(MAX_SYNCED_SESSION_PR_REFS + 1),
      prs: buildPrs(MAX_SYNCED_SESSION_PR_REFS),
    };
    expect(parseDesktopAgentSessionsPayload(buildPayload([session])).ok).toBe(
      false
    );
  });

  it("rejects when prs alone exceeds the raised cap (prRefs at cap)", () => {
    // The legacy `prs` array carries its own `.max(MAX_SYNCED_SESSION_PR_REFS)`
    // and must reject independently when `prRefs` is within bounds.
    const session = {
      ...buildMinimalSession(),
      prRefs: buildPrRefs(MAX_SYNCED_SESSION_PR_REFS),
      prs: buildPrs(MAX_SYNCED_SESSION_PR_REFS + 1),
    };
    expect(parseDesktopAgentSessionsPayload(buildPayload([session])).ok).toBe(
      false
    );
  });
});

// ---------------------------------------------------------------------------
// ISS-4445 (wongk): persistSessionPrArtifactLinks must not issue a per-branch
// read inside the batch-wide sync transaction. Previously the persist loop ran
// one `findFirst` per resolved branch (then one upsert), so a large session
// doubled the statement count and could time out the 30s transaction — rolling
// back the whole sync batch. The merge-base reads are now a single `findMany`.
// This drives the real persist function with a mock `tx` that TALLIES calls per
// Prisma model method, so it asserts the bounded query shape without a DB.
// ---------------------------------------------------------------------------

describe("persistSessionPrArtifactLinks — bounded query count at cap", () => {
  type CallCounts = Record<string, number>;

  /**
   * A mock transaction client that records how many times each
   * `model.method` is invoked. `resolvedBranchByPrNumber` seeds which PRs
   * resolve to a verified PullRequestDetail (→ a branchArtifactId), so we can
   * drive N distinct resolved branches through the persist loop.
   */
  function buildCountingTx(resolvedBranchByPrNumber: Map<number, string>) {
    const calls: CallCounts = {};
    const bump = (key: string) => {
      calls[key] = (calls[key] ?? 0) + 1;
    };
    const tx = {
      gitHubInstallation: {
        findFirst: () => {
          bump("gitHubInstallation.findFirst");
          return Promise.resolve({ id: "inst-1" });
        },
      },
      gitHubInstallationRepository: {
        findMany: () => {
          bump("gitHubInstallationRepository.findMany");
          // One repo id for the single repositoryFullName used below.
          return Promise.resolve([{ id: "repo-1", fullName: "org/repo" }]);
        },
      },
      pullRequestDetail: {
        findMany: () => {
          bump("pullRequestDetail.findMany");
          return Promise.resolve(
            [...resolvedBranchByPrNumber.entries()].map(
              ([number, branchArtifactId]) => ({
                repositoryId: "repo-1",
                number,
                branchArtifactId,
              })
            )
          );
        },
      },
      artifactLink: {
        deleteMany: () => {
          bump("artifactLink.deleteMany");
          return Promise.resolve({ count: 0 });
        },
        findMany: () => {
          bump("artifactLink.findMany");
          // No pre-existing links → empty merge base for every branch.
          return Promise.resolve([]);
        },
        findFirst: () => {
          // The regressed per-branch read. Must never be called now.
          bump("artifactLink.findFirst");
          return Promise.resolve(null);
        },
        upsert: () => {
          bump("artifactLink.upsert");
          return Promise.resolve({});
        },
      },
    };
    return { tx, calls };
  }

  function buildResolvedPrRefs(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      repositoryFullName: "org/repo",
      prNumber: i + 1,
      relationType: SessionPrRelationType.Created,
    }));
  }

  it("issues ONE merge-base read (findMany), never a per-branch findFirst, at the raised cap", async () => {
    const atCap = MAX_SYNCED_SESSION_PR_REFS;
    // Each PR resolves to its OWN branch, so byBranch has `atCap` distinct
    // entries — the worst case for the loop. Under the old code that was `atCap`
    // findFirst calls; under the batched code it is a single findMany.
    const resolved = new Map<number, string>(
      Array.from({ length: atCap }, (_, i) => [i + 1, `branch-${i + 1}`])
    );
    const { tx, calls } = buildCountingTx(resolved);

    await persistSessionPrArtifactLinks(
      tx as any,
      "org-1",
      "session-artifact-1",
      buildResolvedPrRefs(atCap)
    );

    // The regressed per-branch read is gone entirely.
    expect(calls["artifactLink.findFirst"]).toBeUndefined();
    // Exactly one batched merge-base read regardless of branch count.
    expect(calls["artifactLink.findMany"]).toBe(1);
    // The organization-scoped repository query now traverses every active
    // installation directly; an arbitrary single-installation lookup must not
    // return.
    expect(calls["gitHubInstallation.findFirst"]).toBeUndefined();
    expect(calls["gitHubInstallationRepository.findMany"]).toBe(1);
    expect(calls["pullRequestDetail.findMany"]).toBe(1);
    expect(calls["artifactLink.deleteMany"]).toBe(1);
    // Total read/delete statements are bounded by a small constant (4), NOT
    // O(N): repo + prDetail + mergeBase + deleteMany. The N upserts are the
    // inherent write cost; the fix removes the N reads that doubled it.
    const readCalls =
      (calls["gitHubInstallation.findFirst"] ?? 0) +
      (calls["gitHubInstallationRepository.findMany"] ?? 0) +
      (calls["pullRequestDetail.findMany"] ?? 0) +
      (calls["artifactLink.findMany"] ?? 0) +
      (calls["artifactLink.findFirst"] ?? 0) +
      (calls["artifactLink.deleteMany"] ?? 0);
    expect(readCalls).toBeLessThanOrEqual(4);
    // The upserts scale with distinct branches (inherent), one per branch.
    expect(calls["artifactLink.upsert"]).toBe(atCap);
  });
});

// ---------------------------------------------------------------------------
// Const-object enum values (AC 59)
// ---------------------------------------------------------------------------

describe("SessionPrRelationType enum values", () => {
  it("SessionPrRelationType.Created is 'CREATED'", () => {
    expect(SessionPrRelationType.Created).toBe("CREATED");
  });

  it("SessionPrRelationType.Referenced is 'REFERENCED'", () => {
    expect(SessionPrRelationType.Referenced).toBe("REFERENCED");
  });
});

// ---------------------------------------------------------------------------
// agentSessionsService.getArtifactSessionUsage (AC 65)
// ---------------------------------------------------------------------------

describe("agentSessionsService.getArtifactSessionUsage", () => {
  const ORG_ID = "org-1";
  const ARTIFACT_ID = "artifact-1";

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("returns null when the artifact does not exist", async () => {
    getMockWithDb().mockResolvedValueOnce(null);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).toBeNull();
  });

  it("returns zero-count summary when no session links exist", async () => {
    getMockWithDb()
      // artifact lookup
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: "FEA-1684" })
      // artifactLink.findMany — no links
      .mockResolvedValueOnce([]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).not.toBeNull();
    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.artifactId).toBe(ARTIFACT_ID);
    expect(summary.artifactSlug).toBe("FEA-1684");
    expect(summary.sessionCount).toBe(0);
    expect(summary.inputTokens).toBe(0);
    expect(summary.outputTokens).toBe(0);
    expect(summary.cacheReadTokens).toBe(0);
    expect(summary.cacheWriteTokens).toBe(0);
    expect(summary.estimatedCostUsd).toBe(0);
    expect(summary.byModel).toEqual([]);
  });

  it("aggregates totals and byModel rows when sessions exist", async () => {
    getMockWithDb()
      // artifact lookup
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: "FEA-1684" })
      // artifactLink.findMany — two linked sessions
      .mockResolvedValueOnce([
        { sourceId: "session-a" },
        { sourceId: "session-b" },
      ])
      // Promise.all([aggregate, groupBy])
      .mockResolvedValueOnce([
        {
          _count: { _all: 2 },
          _sum: {
            inputTokens: 1000,
            outputTokens: 500,
            cacheReadTokens: 200,
            cacheWriteTokens: 100,
            estimatedCost: 0.05,
          },
        },
        [
          {
            model: "claude-sonnet-4",
            _sum: {
              inputTokens: 1000,
              outputTokens: 500,
              cacheReadTokens: 200,
              cacheWriteTokens: 100,
              estimatedCost: 0.05,
            },
          },
        ],
      ]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    expect(result).not.toBeNull();
    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.sessionCount).toBe(2);
    expect(summary.inputTokens).toBe(1000);
    expect(summary.outputTokens).toBe(500);
    expect(summary.cacheReadTokens).toBe(200);
    expect(summary.cacheWriteTokens).toBe(100);
    expect(summary.estimatedCostUsd).toBeCloseTo(0.05);
    expect(summary.byModel).toHaveLength(1);
    expect(summary.byModel[0]?.model).toBe("claude-sonnet-4");
  });

  it("sorts byModel rows by estimatedCostUsd descending", async () => {
    getMockWithDb()
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: null })
      .mockResolvedValueOnce([{ sourceId: "session-a" }])
      .mockResolvedValueOnce([
        {
          _count: { _all: 1 },
          _sum: {
            inputTokens: 500,
            outputTokens: 200,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            estimatedCost: 0.03,
          },
        },
        [
          {
            model: "claude-haiku-3",
            _sum: {
              inputTokens: 100,
              outputTokens: 50,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0.001,
            },
          },
          {
            model: "claude-sonnet-4",
            _sum: {
              inputTokens: 400,
              outputTokens: 150,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              estimatedCost: 0.029,
            },
          },
        ],
      ]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.byModel[0]?.model).toBe("claude-sonnet-4");
    expect(summary.byModel[1]?.model).toBe("claude-haiku-3");
  });

  it("uses artifactId and null slug from the resolved artifact row", async () => {
    getMockWithDb()
      // artifact with no slug
      .mockResolvedValueOnce({ id: ARTIFACT_ID, slug: null })
      // no links
      .mockResolvedValueOnce([]);

    const result = await agentSessionsService.getArtifactSessionUsage(
      ORG_ID,
      ARTIFACT_ID
    );

    const summary = result as ArtifactSessionUsageSummary;
    expect(summary.artifactId).toBe(ARTIFACT_ID);
    expect(summary.artifactSlug).toBeNull();
  });

  it("scopes the link lookup to the organization", async () => {
    const findManySpy = vi.fn().mockResolvedValue([]);
    const findFirstSpy = vi
      .fn()
      .mockResolvedValue({ id: ARTIFACT_ID, slug: "FEA-1684" });
    const db = {
      artifact: { findFirst: findFirstSpy },
      artifactLink: { findMany: findManySpy },
    };
    getMockWithDb().mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );

    await agentSessionsService.getArtifactSessionUsage(ORG_ID, ARTIFACT_ID);

    expect(findManySpy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organizationId: ORG_ID,
          targetId: ARTIFACT_ID,
          source: expect.objectContaining({ organizationId: ORG_ID }),
        }),
      })
    );
  });
});
