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
  Prisma: {
    DbNull: "DbNull",
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings,
      values,
    }),
  },
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
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import type { ArtifactLink } from "@repo/database";
import { withDb } from "@repo/database";
import { LinkType } from "@repo/database/generated/enums";
import { mockDeep } from "vitest-mock-extended";
import { agentSessionsService } from "@/app/agent-sessions/service";
import { persistSessionPrArtifactLinks } from "@/app/agent-sessions/service/artifact-links/pr-links";
import { sessionPullRequestDetailKey } from "@/app/agent-sessions/service/artifact-links/pull-request-details";
import type { AgentSessionUpsertTx } from "@/app/agent-sessions/service/records";
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
          repositoryFullName: "closedloop-ai/closedloop-ai",
          prNumber: 42,
          prUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/42",
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
    // ISS-8005: the first parse issue under sessions[*] maps to
    // "session_invalid" followed by the field path that failed.
    if (result.ok) {
      return;
    }
    expect(result.reason).toBe(
      "session_invalid:sessions[0].artifactRefs[0].slug"
    );
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
// ISS-4445 raised the cloud prRefs `.max()` 100 → 500, ISS-8051 removed it, and
// ISS-9859 removed the desktop's 100-ref producer cap together with the two
// constants that anchored it. What survives is acceptance: an old desktop's
// ≤100 payload still validates, and a payload past both retired ceilings does.
// ---------------------------------------------------------------------------

describe("prRefs cardinality — accepted past every retired cap", () => {
  function buildPrRefs(count: number, startNumber = 1) {
    return Array.from({ length: count }, (_, i) => ({
      repositoryFullName: "org/repo",
      prNumber: startNumber + i,
      prUrl: `https://github.com/org/repo/pull/${startNumber + i}`,
      relationType: SessionPrRelationType.Created,
    }));
  }

  // A real Desktop payload emits the SAME PR rows twice: the structured
  // `prRefs` AND the legacy `prs` summary array (`{ num, title, status }`),
  // which the cloud validates independently. Building both here keeps the
  // round-trip assertions below covering each array's own parse path.
  // ISS-8051: neither is `.max()`-capped on the cloud any more.
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

  // Both arrays carry the same count, so each case fails if EITHER validator
  // regains a cap at the matching retired ceiling (100 from ISS-4445, then 500).
  it.each([101, 501])("accepts %i prRefs/prs, past a retired cap", (count) => {
    const result = parsePrRefs(count);
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.prRefs).toHaveLength(count);
    expect(result.payload.sessions[0]?.prs).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// ISS-4445 (whitlockk): persistSessionPrArtifactLinks must not issue a per-branch
// read inside the batch-wide sync transaction. Previously the persist loop ran
// one `findFirst` per resolved branch (then one upsert), so a large session
// doubled the statement count and could time out the 30s transaction — rolling
// back the whole sync batch. The merge-base reads are now a single `findMany`.
// This drives the real persist function with a mock `tx` that TALLIES calls per
// Prisma model method, so it asserts the bounded query shape without a DB.
// ---------------------------------------------------------------------------

describe("persistSessionPrArtifactLinks — bounded query count at cap", () => {
  /**
   * A mock transaction client whose per-method call history is the tally. Only
   * the members the persist loop is expected to reach are configured; any other
   * member throws, and the reads it must never issue are asserted uncalled.
   */
  function buildCountingTx() {
    const tx = mockDeep<AgentSessionUpsertTx>({
      fallbackMockImplementation: failUnconfiguredTxMember,
    });
    tx.$executeRaw.mockResolvedValue(1);
    tx.$queryRaw.mockResolvedValue([]);
    tx.branchMaterializationRetry.findMany.mockResolvedValue([]);
    tx.artifactLink.deleteMany.mockResolvedValue({ count: 0 });
    // No pre-existing links → empty merge base for every branch.
    tx.artifactLink.findMany.mockResolvedValue([]);
    tx.artifactLink.upsert.mockResolvedValue(artifactLinkRow());
    return tx;
  }

  function buildResolvedPrRefs(count: number) {
    return Array.from({ length: count }, (_, i) => ({
      repositoryFullName: "org/repo",
      prNumber: i + 1,
      relationType: SessionPrRelationType.Created,
    }));
  }

  it("issues two bounded link reads, never a per-branch findFirst, across 500 branches", async () => {
    const atCap = 500;
    // Each PR resolves to its OWN branch, so byBranch has `atCap` distinct
    // entries — the worst case for the loop. Under the old code that was `atCap`
    // findFirst calls; under the batched code it is a single findMany.
    const resolved = new Map<number, string>(
      Array.from({ length: atCap }, (_, i) => [i + 1, `branch-${i + 1}`])
    );
    const tx = buildCountingTx();
    const details = new Map(
      [...resolved].map(([number, branchArtifactId]) => [
        sessionPullRequestDetailKey("org/repo", number),
        { prDetailId: `pr-${number}`, branchArtifactId },
      ])
    );

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-artifact-1",
      buildResolvedPrRefs(atCap),
      details
    );

    // The regressed per-branch read is gone entirely.
    expect(tx.artifactLink.findFirst).not.toHaveBeenCalled();
    // Compatibility downgrade and post-lock merge-base reads stay constant
    // regardless of branch count. ISS-11608 deleted the third, a discovery read
    // that only fed the per-edge lock list.
    expect(tx.artifactLink.findMany).toHaveBeenCalledTimes(2);
    // The organization-scoped repository query now traverses every active
    // installation directly; an arbitrary single-installation lookup must not
    // return.
    expect(tx.gitHubInstallation.findFirst).not.toHaveBeenCalled();
    expect(tx.gitHubInstallationRepository.findMany).not.toHaveBeenCalled();
    expect(tx.pullRequestDetail.findMany).not.toHaveBeenCalled();
    expect(tx.artifactLink.deleteMany).toHaveBeenCalledTimes(1);
    // Identity resolution is owned by the preceding PullRequestDetail lane.
    const readCalls =
      tx.gitHubInstallation.findFirst.mock.calls.length +
      tx.gitHubInstallationRepository.findMany.mock.calls.length +
      tx.pullRequestDetail.findMany.mock.calls.length +
      tx.artifactLink.findMany.mock.calls.length +
      tx.artifactLink.findFirst.mock.calls.length +
      tx.artifactLink.deleteMany.mock.calls.length;
    expect(readCalls).toBeLessThanOrEqual(4);
    // The upserts scale with distinct branches (inherent), one per branch.
    expect(tx.artifactLink.upsert).toHaveBeenCalledTimes(atCap);
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

// ---------------------------------------------------------------------------
// ISS-8070: the remaining ingest caps in `packages/api/src/types/`.
//
// A known-kind ref is validated STRICTLY, so one over-long field failed the
// single batch parse and rejected every session in the tick — not just the ref
// that carried it. The lengths below are deliberate LITERALS, never derived
// from the bound they defeat, so restoring a cap cannot silently re-satisfy
// them. Fields whose value reaches a btree index column (repositoryFullName,
// branchName, slug) keep their bound here and are handed to ISS-8069; removing
// those without an index-side fix would manufacture the poison batch that
// ticket exists to close.
// ---------------------------------------------------------------------------

/** Past the retired 200-char `method` bound, and not adjacent to it. */
const METHOD_CHARS_PAST_RETIRED_BOUND = 512;
/** Past the retired 500-char `evidenceId` bound. */
const EVIDENCE_ID_CHARS_PAST_RETIRED_BOUND = 1200;
/** Past the retired 1024-char PR `title` bound. */
const TITLE_CHARS_PAST_RETIRED_BOUND = 4096;
/** Past the retired 50-event `branchLifecycleEvents` bound. */
const LIFECYCLE_EVENTS_PAST_RETIRED_BOUND = 64;

function buildLifecycleEvents(count: number) {
  return Array.from({ length: count }, (_, i) => ({
    kind: "pr_raised",
    observedAt: "2026-06-01T10:00:00.000Z",
    evidenceId: `desktop-artifact-link:${i}`,
  }));
}

function parseSessionWithRefs(refs: unknown[]) {
  return parseDesktopAgentSessionsPayload(
    buildPayload([{ ...buildMinimalSession(), artifactRefs: refs }])
  );
}

function branchRef(overrides: Record<string, unknown> = {}) {
  return {
    kind: "branch",
    repositoryFullName: "acme/web",
    branchName: "feature/x",
    method: "git_push",
    relation: "output",
    ...overrides,
  };
}

describe("ingest caps removed for column-free fields (ISS-8070)", () => {
  it("keeps every fixture above the bound it is written to defeat", () => {
    // Assert the property the fixtures are assumed to have rather than trusting
    // it — a fixture that drifted under its bound would be a false green.
    expect(METHOD_CHARS_PAST_RETIRED_BOUND).toBeGreaterThan(200);
    expect(EVIDENCE_ID_CHARS_PAST_RETIRED_BOUND).toBeGreaterThan(500);
    expect(TITLE_CHARS_PAST_RETIRED_BOUND).toBeGreaterThan(1024);
    expect(LIFECYCLE_EVENTS_PAST_RETIRED_BOUND).toBeGreaterThan(50);
  });

  it("accepts a normal branch ref (positive sibling)", () => {
    const result = parseSessionWithRefs([branchRef()]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs).toHaveLength(1);
  });

  it("accepts a branch-ref method past the retired 200-char bound, byte-identical", () => {
    const method = "m".repeat(METHOD_CHARS_PAST_RETIRED_BOUND);

    const result = parseSessionWithRefs([branchRef({ method })]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ref = result.payload.sessions[0]?.artifactRefs?.[0];
    expect(ref).toMatchObject({ method });
    expect((ref as { method: string }).method).toHaveLength(
      METHOD_CHARS_PAST_RETIRED_BOUND
    );
  });

  it("accepts a closedloop-artifact ref method past the retired bound", () => {
    const method = "m".repeat(METHOD_CHARS_PAST_RETIRED_BOUND);

    const result = parseSessionWithRefs([
      {
        kind: "closedloop_artifact",
        slug: "ISS-1234",
        isPrimary: true,
        method,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs?.[0]).toMatchObject({
      method,
    });
  });

  it("accepts a pull-request ref method past the retired bound", () => {
    const method = "m".repeat(METHOD_CHARS_PAST_RETIRED_BOUND);

    const result = parseSessionWithRefs([
      {
        kind: "pull_request",
        repositoryFullName: "acme/web",
        prNumber: 7,
        method,
        relation: "output",
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs?.[0]).toMatchObject({
      method,
    });
  });

  it("accepts a pull-request ref title past the retired 1024-char bound", () => {
    const title = "t".repeat(TITLE_CHARS_PAST_RETIRED_BOUND);

    const result = parseSessionWithRefs([
      {
        kind: "pull_request",
        repositoryFullName: "acme/web",
        prNumber: 7,
        method: "gh_pr_create",
        relation: "output",
        title,
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions[0]?.artifactRefs?.[0]).toMatchObject({
      title,
    });
  });

  it("accepts a lifecycle evidenceId past the retired 500-char bound", () => {
    const evidenceId = `desktop:${"e".repeat(EVIDENCE_ID_CHARS_PAST_RETIRED_BOUND)}`;

    const result = parseSessionWithRefs([
      {
        ...branchRef(),
        branchLifecycleEvents: [{ kind: "pr_raised", evidenceId }],
      },
    ]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ref = result.payload.sessions[0]?.artifactRefs?.[0] as {
      branchLifecycleEvents: { evidenceId: string }[];
    };
    expect(ref.branchLifecycleEvents[0]?.evidenceId).toBe(evidenceId);
  });

  it("accepts more branchLifecycleEvents than the retired 50-event bound", () => {
    const branchLifecycleEvents = buildLifecycleEvents(
      LIFECYCLE_EVENTS_PAST_RETIRED_BOUND
    );

    const result = parseSessionWithRefs([branchRef({ branchLifecycleEvents })]);

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const ref = result.payload.sessions[0]?.artifactRefs?.[0] as {
      branchLifecycleEvents: unknown[];
    };
    expect(ref.branchLifecycleEvents).toHaveLength(
      LIFECYCLE_EVENTS_PAST_RETIRED_BOUND
    );
  });

  it("does not let one over-long ref reject its SIBLING SESSIONS in the batch", () => {
    // The defining harm: a known-kind ref is validated strictly, so a single
    // over-long field failed the one batch parse and took every unrelated
    // session in the tick with it.
    const poisoned = {
      ...buildMinimalSession("sess-poison"),
      artifactRefs: [
        branchRef({ method: "m".repeat(METHOD_CHARS_PAST_RETIRED_BOUND) }),
      ],
    };
    const innocent = { ...buildMinimalSession("sess-innocent") };

    const result = parseDesktopAgentSessionsPayload(
      buildPayload([poisoned, innocent])
    );

    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.payload.sessions).toHaveLength(2);
    expect(result.payload.sessions.map((s) => s.externalSessionId)).toEqual([
      "sess-poison",
      "sess-innocent",
    ]);
  });
});

describe("index-participating ingest caps stay until ISS-8069 (ISS-8070 case 2)", () => {
  // These values reach a btree index column, so dropping the wire bound without
  // an index-side fix converts a legible 400 into a mid-batch 22001/index-row
  // failure that the desktop retries forever. ISS-8069 owns that fix; these
  // pin the deliberate exclusion so a later sweep cannot quietly remove them.
  it("still bounds branchName and repositoryFullName, which key branch_details", () => {
    expect(
      parseSessionWithRefs([
        branchRef({ branchName: `feature/${"b".repeat(4096)}` }),
      ]).ok
    ).toBe(false);
    expect(
      parseSessionWithRefs([
        branchRef({ repositoryFullName: `acme/${"r".repeat(4096)}` }),
      ]).ok
    ).toBe(false);
  });
});

function failUnconfiguredTxMember(): never {
  throw new Error(
    "persistSessionPrArtifactLinks reached a tx member this test did not configure"
  );
}

/** A complete `artifact_links` row; the persist loop ignores what `upsert` returns. */
function artifactLinkRow(): ArtifactLink {
  return {
    id: "link-1",
    organizationId: "org-1",
    sourceId: "session-artifact-1",
    targetId: "branch-1",
    linkType: LinkType.RELATES_TO,
    sortOrder: null,
    branchParticipation: null,
    branchParticipationMethod: null,
    branchParticipationObservedAt: null,
    lastContributedAt: null,
    metadata: null,
    createdAt: new Date(0),
  };
}
