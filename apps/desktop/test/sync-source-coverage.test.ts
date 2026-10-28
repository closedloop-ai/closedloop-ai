/**
 * ISS-10514: branch coverage for `src/main/database/sync-source.ts`, driven
 * through a real migrated SQLite store. Pins what the sync source does today
 * for the arms no neighbouring suite reaches: the default diagnostic sink, the
 * analytics failure, the chunked usage load, unpriced models, and the optional
 * fields a link or token row omits.
 */
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { BranchActivityEvidenceCompleteness } from "@repo/api/src/types/branch-activity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { MonitoredSessionActivityEventKind } from "@repo/api/src/types/session-monitored-activity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createSessionAttributionResolverCache } from "../src/main/agent-sync/agent-session-attribution.js";
import { ANALYTICS_AGGREGATE_UNAVAILABLE_MESSAGE } from "../src/main/agent-sync/agent-session-read-model.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  createSqliteSessionSyncSource,
  getArtifactSessionUsage,
} from "../src/main/database/sync-source.js";
import { SYNCED_SESSION_HYDRATE_CHUNK_SIZE } from "../src/main/database/synced-session-hydration-plan.js";

type SqliteDb = Awaited<ReturnType<typeof openSqliteAgentDatabase>>;

const NOW = "2026-09-17T12:00:00.000Z";
// An unknown-but-named model is priced by the FEA-3546 Opus fallback, so the
// only model id `computeHarnessCost` leaves unpriced is the empty one.
const UNPRICED_MODEL = "";
// A named model the price table lacks; the fallback would price it.
const FALLBACK_PRICED_MODEL = "no-such-vendor/unknown-model";
const PRICED_MODEL = "claude-opus-4-5";
const REPO = "acme/widgets";
const OBSERVED_AT = "2026-09-16T08:10:00.000Z";
const CLOSED_AT = "2026-09-16T09:00:01.000Z";
const COST_OMITTED_PATTERN =
  /holds an authoritative cost this build will not publish/;

let dir = "";
let db: SqliteDb;

beforeEach(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "iss10514-sync-source-"));
  db = await openSqliteAgentDatabase({
    dataDir: path.join(dir, "agent-dashboard.pgdata"),
    detectBillingMode: () => "api",
    now: () => NOW,
  });
});

afterEach(async () => {
  await db.close();
  await rm(dir, { recursive: true, force: true });
});

async function insertSession(
  id: string,
  extra: { repoFullName?: string; authoritativeCostUsd?: number } = {}
): Promise<void> {
  await db.run(
    `INSERT INTO sessions (id, status, harness, started_at, updated_at, billing_mode, repo_full_name, authoritative_cost_usd)
     VALUES ($1, $2, 'claude_code', '2026-09-16T08:00:00.000Z', $3, 'api', $4, $5)`,
    id,
    SESSION_STATUS.INACTIVE,
    NOW,
    extra.repoFullName ?? null,
    extra.authoritativeCostUsd ?? null
  );
}

async function insertToken(
  sessionId: string,
  model: string,
  opts: {
    input: number;
    cost: number | null;
    cacheWrite5m?: number | null;
    cacheWrite1h?: number | null;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO token_usage (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens, cache_write_5m_tokens, cache_write_1h_tokens, cost_usd_estimated)
     VALUES ($1, $2, $3, 0, 0, 0, $4, $5, $6)`,
    sessionId,
    model,
    opts.input,
    opts.cacheWrite5m ?? null,
    opts.cacheWrite1h ?? null,
    opts.cost
  );
}

type ArtifactSeed = {
  id: string;
  kind: string;
  slug?: string;
  prNumber?: number;
  branchName?: string;
  sha?: string;
  url?: string;
};

async function insertLink(
  sessionId: string,
  artifact: ArtifactSeed,
  link: {
    relation: string;
    method: string;
    observedAt: string;
    evidence?: string;
  }
): Promise<void> {
  await db.run(
    `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, slug, pr_number, branch_name, sha, url, created_at, last_seen_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 't1', 't1')`,
    artifact.id,
    `identity:${artifact.id}`,
    artifact.kind,
    REPO,
    artifact.slug ?? null,
    artifact.prNumber ?? null,
    artifact.branchName ?? null,
    artifact.sha ?? null,
    artifact.url ?? null
  );
  await db.run(
    `INSERT INTO session_artifact_links (id, session_id, artifact_id, relation, method, evidence, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, $5, $6, 1, $7, $8)`,
    `link-${artifact.id}`,
    sessionId,
    artifact.id,
    link.relation,
    link.method,
    link.evidence ?? "{}",
    link.observedAt,
    `c-${artifact.id}`
  );
}

function monitoredCarrier() {
  return {
    completeness: BranchActivityEvidenceCompleteness.Complete,
    events: [
      {
        kind: MonitoredSessionActivityEventKind.AgentAction,
        sourceEventId: "monitored_session_v1:iss10514",
        occurredAt: "2026-09-16T08:05:00.000Z",
        completeness: BranchActivityEvidenceCompleteness.Complete,
      },
    ],
  };
}

describe("createSqliteSessionSyncSource default diagnostic sink", () => {
  it("omits an unpublishable authoritative cost without a sink, and names it to a wired sink", async () => {
    await insertSession("s-cost", { authoritativeCostUsd: -5 });

    const [silent] = await createSqliteSessionSyncSource(
      db.prisma
    ).loadSyncedSessions(["s-cost"], createSessionAttributionResolverCache());
    expect(silent?.externalSessionId).toBe("s-cost");
    expect(silent && Object.hasOwn(silent, "authoritativeCostUsd")).toBe(false);

    const messages: string[] = [];
    const [wired] = await createSqliteSessionSyncSource(db.prisma, (message) =>
      messages.push(message)
    ).loadSyncedSessions(["s-cost"], createSessionAttributionResolverCache());
    expect(wired && Object.hasOwn(wired, "authoritativeCostUsd")).toBe(false);
    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatch(COST_OMITTED_PATTERN);
  });
});

describe("aggregateAnalytics", () => {
  it("rejects with the sanitized message, never an empty aggregate, when a grouped read fails", async () => {
    await insertSession("s-analytics");
    await db.run("DROP TABLE agents");
    const logged: string[] = [];
    const source = createSqliteSessionSyncSource(db.prisma, (message) =>
      logged.push(message)
    );

    await expect(
      source.aggregateAnalytics?.({}, createSessionAttributionResolverCache())
    ).rejects.toThrow(new Error(ANALYTICS_AGGREGATE_UNAVAILABLE_MESSAGE));
    expect(logged).toHaveLength(1);
    expect(logged[0]).toContain("no such table: agents");
  });
});

describe("aggregateUsage", () => {
  it("counts an unpriced model's cost as zero rather than dropping its tokens", async () => {
    await insertSession("s-usage");
    await insertToken("s-usage", UNPRICED_MODEL, { input: 1000, cost: null });

    const aggregate = await db.syncSource.aggregateUsage?.({});

    const group = aggregate?.tokenGroups.find(
      (row) => row.model === UNPRICED_MODEL
    );
    expect(group).toMatchObject({
      inputTokens: 1000,
      sessionCount: 1,
      estimatedCostUsd: 0,
    });
  });
});

describe("loadUsageSessions", () => {
  it("returns nothing for an empty id list", async () => {
    await insertSession("s-unused");
    expect(await db.syncSource.loadUsageSessions?.([])).toEqual([]);
  });

  it("splits an id list past the hydrate chunk size and keeps the caller's order", async () => {
    const count = SYNCED_SESSION_HYDRATE_CHUNK_SIZE + 2;
    const ids = Array.from(
      { length: count },
      (_, i) => `s-bulk-${String(i).padStart(4, "0")}`
    );
    const values = ids
      .map(
        (id) =>
          `('${id}', '${SESSION_STATUS.INACTIVE}', 'claude_code', '${NOW}', '${NOW}')`
      )
      .join(",");
    await db.run(
      `INSERT INTO sessions (id, status, harness, started_at, updated_at) VALUES ${values}`
    );
    const requested = [...ids].reverse();

    const loaded = await db.syncSource.loadUsageSessions?.(requested);

    expect(loaded?.map((session) => session.externalSessionId)).toEqual(
      requested
    );
  });

  it("attributes a session to its stored repository name when it has no live cwd", async () => {
    await insertSession("s-stored-repo", { repoFullName: REPO });
    await insertSession("s-no-repo");

    const loaded = await db.syncSource.loadUsageSessions?.([
      "s-stored-repo",
      "s-no-repo",
    ]);

    expect(loaded?.[0]?.attribution).toEqual({
      repositoryFullName: REPO,
      worktreePath: null,
      sourceArtifactId: null,
      baseBranch: null,
    });
    expect(loaded?.[1]?.attribution).toBeUndefined();
  });
});

describe("loadSyncedSessions link projection", () => {
  it("omits relation and observedAt on a document ref whose stored values are unknown or empty", async () => {
    await insertSession("s-doc");
    await insertLink(
      "s-doc",
      { id: "doc-1", kind: "closedloop_artifact", slug: "ISS-10514" },
      {
        relation: "not-a-relation",
        method: ArtifactRefMethod.SlugInMessage,
        observedAt: "",
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-doc"],
      createSessionAttributionResolverCache()
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.ClosedloopArtifact
    );
    expect(ref).toEqual({
      kind: ArtifactRefTargetKind.ClosedloopArtifact,
      slug: "ISS-10514",
      isPrimary: false,
      method: ArtifactRefMethod.SlugInMessage,
    });
  });

  it("defaults an unknown branch relation to workspace and omits absent optional fields", async () => {
    await insertSession("s-branch");
    await insertLink(
      "s-branch",
      { id: "branch-1", kind: "branch", branchName: "feat/iss-10514" },
      {
        relation: "not-a-relation",
        method: ArtifactRefMethod.GitCommand,
        observedAt: "",
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-branch"],
      createSessionAttributionResolverCache(),
      { includeMonitoredSessionActivity: true }
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.Branch
    );
    expect(ref?.kind).toBe(ArtifactRefTargetKind.Branch);
    if (ref?.kind !== ArtifactRefTargetKind.Branch) {
      return;
    }
    expect(ref.relation).toBe(ArtifactRefRelation.Workspace);
    expect(Object.hasOwn(ref, "observedAt")).toBe(false);
    // Every relation the default can land on maps to a lifecycle kind, so a
    // branch ref always carries one boundary event.
    expect(ref.branchLifecycleEvents?.map((event) => event.kind)).toEqual([
      BranchLifecycleBoundaryKind.ReadOnlyReference,
    ]);
    expect(Object.hasOwn(ref, "monitoredSessionActivity")).toBe(false);
  });

  it("carries a PR ref's head branch and monitored activity, and defaults an unknown relation to referenced", async () => {
    const carrier = monitoredCarrier();
    await insertSession("s-pr");
    await insertLink(
      "s-pr",
      {
        id: "pr-1",
        kind: "pull_request",
        prNumber: 42,
        branchName: "feat/head",
      },
      {
        relation: "not-a-relation",
        method: ArtifactRefMethod.PrUrlInToolUse,
        observedAt: "",
        evidence: JSON.stringify({ monitoredSessionActivity: carrier }),
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-pr"],
      createSessionAttributionResolverCache(),
      { includeMonitoredSessionActivity: true }
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.PullRequest
    );
    expect(ref?.kind).toBe(ArtifactRefTargetKind.PullRequest);
    if (ref?.kind !== ArtifactRefTargetKind.PullRequest) {
      return;
    }
    expect(ref.relation).toBe(ArtifactRefRelation.Referenced);
    expect(ref.branchName).toBe("feat/head");
    expect(ref.monitoredSessionActivity).toEqual(carrier);
    expect(Object.hasOwn(ref, "observedAt")).toBe(false);
    // A referenced PR raises no lifecycle boundary, so the key is omitted.
    expect(Object.hasOwn(ref, "branchLifecycleEvents")).toBe(false);
    expect(session?.prRefs).toStrictEqual([
      {
        repositoryFullName: REPO,
        prNumber: 42,
        relationType: SessionPrRelationType.Referenced,
      },
    ]);
  });

  it("keeps a prose-mentioned PR as an artifact ref but never as a prRef", async () => {
    await insertSession("s-prose");
    await insertLink(
      "s-prose",
      { id: "pr-prose", kind: "pull_request", prNumber: 7 },
      {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.PrMentionInProse,
        observedAt: "2026-09-16T08:10:00.000Z",
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-prose"],
      createSessionAttributionResolverCache()
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.PullRequest
    );
    expect(ref).toMatchObject({
      prNumber: 7,
      method: ArtifactRefMethod.PrMentionInProse,
    });
    expect(session?.prRefs).toEqual([]);
  });

  it("defaults an unknown commit relation to created", async () => {
    await insertSession("s-commit");
    await insertLink(
      "s-commit",
      {
        id: "commit-1",
        kind: "commit",
        sha: "abcdef1",
        branchName: "feat/x",
      },
      {
        relation: "not-a-relation",
        method: ArtifactRefMethod.GitCommand,
        observedAt: NOW,
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-commit"],
      createSessionAttributionResolverCache()
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.Commit
    );
    expect(ref).toMatchObject({
      sha: "abcdef1",
      relation: ArtifactRefRelation.Created,
    });
  });
});

describe("loadSyncedSessions present optional fields", () => {
  it("carries a known relation and observedAt on a document ref", async () => {
    await insertSession("s-doc-full");
    await insertLink(
      "s-doc-full",
      { id: "doc-full", kind: "closedloop_artifact", slug: "ISS-2" },
      {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.SlugInMessage,
        observedAt: OBSERVED_AT,
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-doc-full"],
      createSessionAttributionResolverCache()
    );

    expect(session?.artifactRefs).toStrictEqual([
      {
        kind: ArtifactRefTargetKind.ClosedloopArtifact,
        slug: "ISS-2",
        isPrimary: false,
        method: ArtifactRefMethod.SlugInMessage,
        relation: ArtifactRefRelation.Referenced,
        observedAt: OBSERVED_AT,
      },
    ]);
  });

  it("carries observedAt on a branch ref", async () => {
    await insertSession("s-branch-full");
    await insertLink(
      "s-branch-full",
      { id: "branch-full", kind: "branch", branchName: "feat/full" },
      {
        relation: ArtifactRefRelation.Created,
        method: ArtifactRefMethod.GitCommand,
        observedAt: OBSERVED_AT,
      }
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-branch-full"],
      createSessionAttributionResolverCache()
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.Branch
    );
    expect(ref).toMatchObject({
      relation: ArtifactRefRelation.Created,
      observedAt: OBSERVED_AT,
    });
  });

  it("carries observedAt and the session's closed lifecycle fact on a PR ref, without a merge fact", async () => {
    await insertSession("s-pr-full");
    await insertLink(
      "s-pr-full",
      { id: "pr-full", kind: "pull_request", prNumber: 77 },
      {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.PrUrlInToolUse,
        observedAt: OBSERVED_AT,
      }
    );
    await db.run(
      `INSERT INTO pull_requests (id, session_id, pr_url, pr_number, repo_full_name, closed_at, observed_at, created_at)
       VALUES ('pr-row-full', 's-pr-full', $1, 77, $2, $3, $4, $4)`,
      `https://github.com/${REPO}/pull/77`,
      REPO,
      CLOSED_AT,
      NOW
    );

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-pr-full"],
      createSessionAttributionResolverCache()
    );

    const ref = session?.artifactRefs?.find(
      (candidate) => candidate.kind === ArtifactRefTargetKind.PullRequest
    );
    expect(ref).toMatchObject({
      prNumber: 77,
      observedAt: OBSERVED_AT,
      closedAt: CLOSED_AT,
    });
    expect(ref).not.toHaveProperty("mergedAt");
  });
});

describe("loadSyncedSessions token projection", () => {
  it("omits the TTL split when neither cache-write subdivision is stored", async () => {
    await insertSession("s-no-ttl");
    await insertToken("s-no-ttl", UNPRICED_MODEL, { input: 10, cost: null });

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-no-ttl"],
      createSessionAttributionResolverCache()
    );

    expect(session?.tokenUsageByModel).toStrictEqual([
      {
        model: UNPRICED_MODEL,
        inputTokens: 10,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
      },
    ]);
  });

  it("emits the cache-write TTL split and omits the cost of an unpriced model", async () => {
    await insertSession("s-ttl");
    // The 1h write count exceeds the total write count, so the harness pricer
    // refuses the row even for a fallback-priceable model.
    await insertToken("s-ttl", FALLBACK_PRICED_MODEL, {
      input: 100,
      cost: null,
      cacheWrite5m: 30,
      cacheWrite1h: 40,
    });

    const [session] = await db.syncSource.loadSyncedSessions(
      ["s-ttl"],
      createSessionAttributionResolverCache()
    );

    expect(session?.tokenUsageByModel).toStrictEqual([
      {
        model: FALLBACK_PRICED_MODEL,
        inputTokens: 100,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        cacheWrite5mTokens: 30,
        cacheWrite1hTokens: 40,
      },
    ]);
  });
});

describe("getArtifactSessionUsage", () => {
  it("returns nothing for an empty slug list", async () => {
    expect(await getArtifactSessionUsage(db.prisma, [])).toEqual([]);
  });

  it("folds every model of a slug, prices an unpriced model at zero, and zero-fills an unlinked slug", async () => {
    await insertSession("s-art");
    await insertLink(
      "s-art",
      { id: "doc-art", kind: "closedloop_artifact", slug: "ISS-1" },
      {
        relation: ArtifactRefRelation.Referenced,
        method: ArtifactRefMethod.SlugInMessage,
        observedAt: NOW,
      }
    );
    await insertToken("s-art", PRICED_MODEL, { input: 1000, cost: 0.25 });
    await insertToken("s-art", UNPRICED_MODEL, { input: 500, cost: null });

    const usage = await getArtifactSessionUsage(db.prisma, [
      "ISS-1",
      "ISS-unlinked",
    ]);

    expect(usage).toEqual([
      {
        artifactSlug: "ISS-1",
        sessionCount: 1,
        inputTokens: 1500,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0.25,
      },
      {
        artifactSlug: "ISS-unlinked",
        sessionCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        estimatedCostUsd: 0,
      },
    ]);
  });
});
