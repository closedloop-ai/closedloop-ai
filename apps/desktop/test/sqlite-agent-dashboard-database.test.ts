import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import { PullRequestState } from "@repo/api/src/types/document";
import { SessionPrRelationType } from "@repo/api/src/types/session-artifact-link";
import {
  SESSION_TRACE_SOURCE_LIMITS,
  SessionPrLifecycleStatus,
  SessionTraceCorrectionKind,
  SessionTracePhaseSourceType,
} from "@repo/lib/session-trace/derivation";
import { InsightsSection } from "@closedloop-ai/loops-api/insights";
import { SESSION_PAYLOAD_BYTE_CAP } from "../src/main/agent-sync/agent-session-sync-backoff-policy.js";
import { buildAgentSessionSyncSourceKey } from "../src/main/agent-sync/agent-session-sync-source.js";
import { resolveTokenUsageCostUsd } from "../src/main/agent-sync/agent-session-token-cost-resolution.js";
import { getSharedBranches } from "../src/main/branch/shared-branches-api.js";
import { parseSessionFile as parseClaudeFile } from "../src/main/collectors/claude/claude-parser.js";
import { createCodexCollector } from "../src/main/collectors/codex/codex-collector.js";
import type { NormalizedSession } from "../src/main/collectors/types.js";
import { InvalidTokenCountError } from "../src/main/cost/token-counts.js";
import { normalizeRepoFullName } from "../src/main/database/db-helpers.js";
import { chunkWatermark } from "../src/main/database/session-sync-watermark.js";
import { openSqliteAgentDatabase } from "../src/main/database/sqlite.js";
import {
  artifactIdFromIdentityKey,
  computeIdentityKey,
} from "../src/main/enrichment/identity-key.js";
import { repairPollutedRepoFullNames } from "../src/main/enrichment/repo-fullname-repair.js";
import { getSharedAgentSessionAnalytics } from "../src/main/session/shared-agent-sessions-api.js";
import { initGitRepoWithOrigin } from "./attribution-test-helpers.js";
import {
  insertSqliteEvent,
  insertSqliteSession,
} from "./sqlite-session-fixtures.js";

// `getInsights` returns a union; narrow `charts` to the Delivery arm first.
const DELIVERY_CHARTS_MESSAGE = "expected the Delivery insights charts";

// FEA-4299: the Repository breakdown keys on the resolved Git remote
// `repositoryFullName`, never a `worktreePath`/`cwd` folder name. To exercise the
// per-repo fold with real identities, seed real git repos whose `origin` remote
// resolves via the shared `initGitRepoWithOrigin` helper — the same technique as
// `sync-source-repo-attribution.test.ts`.

test("SQLite dashboard database starts empty and fills from hook events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const changed: string[] = [];

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: (sessionId) => changed.push(sessionId),
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    assert.deepEqual(await db.sessions.getAll(), []);

    const processed = await db.processEvent(
      "SessionStart",
      {
        session_id: "sqlite-session-1",
        cwd: "/workspace/project",
        model: "claude-sonnet-4-5",
      },
      "claude"
    );

    assert.equal(processed, true);
    assert.deepEqual(changed, ["sqlite-session-1"]);

    const session = await db.sessions.getById("sqlite-session-1");
    assert.equal(session?.id, "sqlite-session-1");
    assert.equal(session?.status, "active");
    assert.equal(session?.harness, "claude");
    assert.equal(session?.billingMode, "metered_api");

    const agents = await db.agents.getBySession("sqlite-session-1");
    assert.equal(agents.length, 1);
    assert.equal(agents[0].id, "sqlite-session-1-main");

    const events = await db.events.getBySession("sqlite-session-1");
    assert.equal(events.length, 1);
    assert.equal(events[0].eventType, "SessionStart");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-1962: sync_state round-trips across reopen, separates by source key, and invalidates on data-revision change", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const keyA = buildAgentSessionSyncSourceKey("org:user:target-a");
  const keyB = buildAgentSessionSyncSourceKey("org:user:target-b");
  const stateA = {
    observedTopUpdatedAt: "2026-06-08T12:05:00.000Z",
    observedIdsAtTopUpdatedAt: ["a", "b"],
    // Migration 0022: dead-lettered ids round-trip on the cursor so the
    // watermark can advance past intentionally-abandoned rows.
    deadLetteredIds: ["dead-1", "dead-2"],
  };
  const stateB = {
    observedTopUpdatedAt: "2026-06-09T01:00:00.000Z",
    observedIdsAtTopUpdatedAt: ["x"],
    deadLetteredIds: [],
  };

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    await db.syncSource.advanceSyncState?.(keyA, stateA);
    await db.syncSource.advanceSyncState?.(keyB, stateB);

    // Two principal/target keys persist and load independently.
    assert.deepEqual(await db.syncSource.loadSyncState?.(keyA), stateA);
    assert.deepEqual(await db.syncSource.loadSyncState?.(keyB), stateB);
    assert.equal(
      await db.syncSource.loadSyncState?.(
        buildAgentSessionSyncSourceKey("org:user:unknown")
      ),
      null
    );
  } finally {
    await db.close();
  }

  // Reopen the same data dir — the cursor survives a desktop restart.
  const reopened = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });
  try {
    assert.deepEqual(await reopened.syncSource.loadSyncState?.(keyA), stateA);

    // Backward compat (migration 0022): a cursor written before the
    // dead_lettered_ids column existed has a NULL value; it must load as `[]`
    // (no dead-letters set aside) rather than throwing or dropping the cursor.
    await reopened.run(
      "UPDATE sync_state SET dead_lettered_ids = NULL WHERE source_key = $1",
      keyA
    );
    assert.deepEqual(await reopened.syncSource.loadSyncState?.(keyA), {
      ...stateA,
      deadLetteredIds: [],
    });

    // FEA-3659: a cursor stamped under a different DATA_REVISION must now SURVIVE
    // (targeted re-sync). Previously it loaded as `null` to force a full corpus
    // re-walk; that is no longer needed because a byte-identical re-derivation no
    // longer bumps updated_at, so the incremental watermark scan picks up only the
    // genuinely-changed rows. The durable watermark/ids/dead-letters must load
    // unchanged despite the stale stamp.
    await reopened.run(
      "UPDATE sync_state SET data_revision = data_revision + 1 WHERE source_key = $1",
      keyA
    );
    assert.deepEqual(await reopened.syncSource.loadSyncState?.(keyA), {
      ...stateA,
      deadLetteredIds: [],
    });
  } finally {
    await reopened.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite close drains queued lifecycle writes before closing", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const write = db.processEvent(
      "SessionStart",
      {
        session_id: "close-drain-session",
        cwd: "/workspace/project",
        model: "claude-sonnet-4-5",
      },
      "claude"
    );
    await db.close();
    assert.equal(await write, true);

    const reopened = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "metered_api",
    });
    try {
      assert.equal(
        (await reopened.sessions.getById("close-drain-session"))?.id,
        "close-drain-session"
      );
    } finally {
      await reopened.close();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite live hook event data is capped before storage", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // `tool_input` is a hook payload object, not a bare string (`HookData`).
    const oversizedPayload = {
      session_id: "large-event-session",
      cwd: "/workspace/project",
      tool_input: { command: "x".repeat(70 * 1024) },
    };
    await db.processEvent("SessionStart", oversizedPayload, "claude");

    const events = await db.events.getBySession("large-event-session");
    assert.deepEqual(JSON.parse(events[0].data ?? "{}"), {
      truncated: true,
      bytes: JSON.stringify(oversizedPayload).length,
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite preserves live hook payloads used for tool details", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      { session_id: "detail-hook-session", cwd: "/workspace/project" },
      "claude"
    );
    await db.processEvent(
      "PreToolUse",
      {
        session_id: "detail-hook-session",
        tool_name: "Read",
        tool_input: {
          file_path: "src/visible.ts",
          prompt: "private prompt",
        },
      },
      "claude"
    );
    await db.processEvent(
      "PostToolUse",
      {
        session_id: "detail-hook-session",
        tool_name: "Bash",
        tool_response: {
          success: false,
          stdout: "secret output",
        },
      },
      "claude"
    );

    const events = await db.events.getBySession("detail-hook-session");
    const readEvent = events.find((event) => event.eventType === "PreToolUse");
    const bashEvent = events.find((event) => event.eventType === "PostToolUse");

    assert.equal(readEvent?.summary, null);
    assert.deepEqual(JSON.parse(readEvent?.data ?? "{}"), {
      session_id: "detail-hook-session",
      tool_name: "Read",
      tool_input: {
        file_path: "src/visible.ts",
        prompt: "private prompt",
      },
    });
    assert.equal(bashEvent?.summary, null);
    assert.deepEqual(JSON.parse(bashEvent?.data ?? "{}"), {
      session_id: "detail-hook-session",
      tool_name: "Bash",
      tool_response: {
        success: false,
        stdout: "secret output",
      },
    });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite workflow queries satisfy PostgreSQL GROUP BY rules", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      {
        session_id: "workflow-session-1",
        cwd: "/workspace/project",
        model: "claude-sonnet-4-5",
      },
      "claude"
    );
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at, parent_agent_id)
       VALUES ($1, $2, $3, 'subagent', 'completed', $4, $4, $5)`,
      "workflow-session-1-sub-a",
      "workflow-session-1",
      "alpha",
      "2026-06-07T12:01:00.000Z",
      "workflow-session-1-main"
    );
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at, parent_agent_id)
       VALUES ($1, $2, $3, 'subagent', 'completed', $4, $4, $5)`,
      "workflow-session-1-sub-b",
      "workflow-session-1",
      "beta",
      "2026-06-07T12:02:00.000Z",
      "workflow-session-1-main"
    );

    const workflow = await db.dashboard.getWorkflowData();

    assert.equal(workflow.stats.totalSubagents, 2);
    assert.deepEqual(
      workflow.orchestration.subagentTypes.map((row) => row.count),
      [2]
    );
    // When subagent_type is NULL the bucket falls back to the agent `type`
    // (here 'subagent'), matching the web/shared `subagentType ?? type ??
    // 'unknown'` identity — NOT the free-text, high-cardinality `name`.
    assert.equal(
      workflow.orchestration.subagentTypes[0].subagentType,
      "subagent"
    );
    assert.equal(workflow.orchestration.edges[0].source, "main");
    // Same identity rule as the bucket above: a NULL-subagent_type child edge
    // falls back to the structured `type` ('subagent'), not the free-text `name`.
    assert.equal(workflow.orchestration.edges[0].target, "subagent");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite workflow avgDurationSec excludes clock-skew (negative) sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // A clean +60s session and a clock-skew session whose ended_at precedes
    // started_at. The skew row must be excluded from the average so a single
    // bad clock can't drag avgDurationSec negative.
    await db.run(
      `INSERT INTO sessions (id, status, started_at, ended_at, updated_at)
       VALUES ($1, 'inactive', $2, $3, $3)`,
      "workflow-dur-ok",
      "2026-06-07T12:00:00.000Z",
      "2026-06-07T12:01:00.000Z"
    );
    await db.run(
      `INSERT INTO sessions (id, status, started_at, ended_at, updated_at)
       VALUES ($1, 'inactive', $2, $3, $3)`,
      "workflow-dur-skew",
      "2026-06-07T12:05:00.000Z",
      "2026-06-07T12:00:00.000Z"
    );

    const workflow = await db.dashboard.getWorkflowData();

    // Only the +60s session counts; the −300s skew row is filtered out.
    assert.equal(workflow.stats.avgDurationSec, 60);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite dashboard core features are filled from imported sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const imported = await db.importer.importSession(
      makeNormalizedSession(),
      "codex"
    );
    assert.equal(imported.skipped, false);

    const features = await db.dashboard.getCoreFeatures();

    assert.equal(features.plans.length, 1);
    assert.equal(features.plans[0].title, "Ship SQLite dashboard parity");
    assert.equal(features.pullRequests.length, 1);
    assert.equal(
      features.pullRequests[0].prUrl,
      "https://github.com/closedloop-ai/closedloop-electron/pull/275"
    );
    const deliveryInsights = await db.dashboard.getInsights(
      InsightsSection.Delivery,
      "90"
    );
    assert.equal(deliveryInsights.kpis[0].value, 1);
    // FEA-2862: "Merged PRs by repository" now counts only in-session-created,
    // merged PRs. This fixture's PR is reference-only (no `gh pr create`) and
    // un-enriched (no pr_state='merged'), so it is captured (KPI = 1 above) but
    // excluded from the merged-by-repo breakdown.
    assert.ok("prByRepo" in deliveryInsights.charts, DELIVERY_CHARTS_MESSAGE);
    assert.deepEqual(deliveryInsights.charts.prByRepo, []);
    assert.equal(
      features.tools.some((tool) => tool.toolName === "Skill"),
      true
    );
    assert.equal(features.skills.length, 1);
    assert.equal(features.skills[0].name, "core/ship-dashboard");
    assert.equal(features.packs.length, 1);
    assert.equal(features.packs[0].id, "core");
    assert.equal(features.subagents.length, 1);
    assert.equal(features.subagents[0].subagentType, "engineer");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer stamps the session branch only on PRs the session CREATED, not referenced ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const referencedUrl =
      "https://github.com/closedloop-ai/symphony-alpha/pull/999";
    const createdUrl =
      "https://github.com/closedloop-ai/symphony-alpha/pull/1000";
    // A session on branch `fea-attribution-A` that (1) merely VIEWS PR #999 —
    // someone else's PR on another branch — and (2) CREATES PR #1000 from its own
    // branch. The bug: persistNormalizedPullRequests stamped session.gitBranch on
    // BOTH, filing the foreign referenced PR onto this session's branch.
    const session: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "pr-branch-attribution-session",
      gitBranch: "fea-attribution-A",
      cwd: "/workspace/symphony-alpha",
      toolUses: [
        {
          // `gh pr view` is NOT a create — PR #999 is only referenced.
          name: "Bash",
          timestamp: "2026-06-07T11:01:00.000Z",
          input: {
            command: "gh pr view 999 --repo closedloop-ai/symphony-alpha",
          },
          output: `Inspecting ${referencedUrl}`,
        },
        {
          // `gh pr create` whose OUTPUT carries the URL → PR #1000 is created.
          name: "Bash",
          timestamp: "2026-06-07T11:02:00.000Z",
          input: { command: "gh pr create --fill" },
          output: `Creating pull request...\n${createdUrl}`,
        },
      ],
      artifacts: {
        prs: [
          {
            number: "999",
            repo: "closedloop-ai/symphony-alpha",
            url: referencedUrl,
          },
          {
            number: "1000",
            repo: "closedloop-ai/symphony-alpha",
            url: createdUrl,
          },
        ],
        issues: [],
        repo: "closedloop-ai/symphony-alpha",
      },
    };

    assert.equal(
      (await db.importer.importSession(session, "claude")).skipped,
      false
    );

    const prRows = await db.prisma.client.$queryRawUnsafe<
      {
        pr_number: number;
        branch_name: string | null;
      }[]
    >(
      `SELECT pr_number, branch_name FROM pull_requests
       WHERE session_id = $1 ORDER BY pr_number ASC`,
      "pr-branch-attribution-session"
    );
    const branchByNumber = new Map(
      prRows.map((row) => [Number(row.pr_number), row.branch_name])
    );

    // Referenced PR #999 must NOT inherit the session branch (root-cause fix):
    // it is another branch's/session's PR the session only looked at.
    assert.equal(branchByNumber.get(999), null);
    // FEA-2177: Created PR #1000 with no per-tool gitBranch gets null — the
    // session.gitBranch fallback was the root cause of mis-attribution. Enrichment
    // fills the correct branch from GitHub's headRefName on the next sweep.
    assert.equal(branchByNumber.get(1000), null);

    // End-to-end (FEA-2531): the branch artifact exists (from session.gitBranch)
    // but carries only a read link with no push evidence, so the Branches
    // surface must NOT list it — display follows pushed branches only.
    const branches = await getSharedBranches(db, {});
    const branchA = branches.items.find(
      (item) => item.branchName === "fea-attribution-A"
    );
    assert.equal(
      branchA,
      undefined,
      "read-only start branch must not be listed"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer attributes a created PR to the branch active at `gh pr create`, not the session start branch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const createdUrl =
      "https://github.com/closedloop-ai/symphony-alpha/pull/2000";
    // The session STARTS on `main` (gitBranch), then pushes `fea-real-head`
    // and opens a PR from it. The preceding successful write is exact evidence:
    // the PR's head must be `fea-real-head`, never the stale session start branch.
    const session: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "pr-head-branch-session",
      gitBranch: "main",
      cwd: "/workspace/symphony-alpha",
      toolUses: [
        {
          name: "Bash",
          timestamp: "2026-06-07T11:02:00.000Z",
          input: {
            command: "git push -u origin fea-real-head && gh pr create --fill",
          },
          output: `Creating pull request...\n${createdUrl}`,
        },
      ],
      artifacts: {
        prs: [
          {
            number: "2000",
            repo: "closedloop-ai/symphony-alpha",
            url: createdUrl,
          },
        ],
        issues: [],
        repo: "closedloop-ai/symphony-alpha",
      },
    };

    assert.equal(
      (await db.importer.importSession(session, "claude")).skipped,
      false
    );

    const prRows = await db.prisma.client.$queryRawUnsafe<
      { branch_name: string | null }[]
    >(
      `SELECT branch_name FROM pull_requests
       WHERE session_id = $1 AND pr_number = $2`,
      "pr-head-branch-session",
      2000
    );
    assert.equal(prRows[0]?.branch_name, "fea-real-head");

    // And the PR artifact carries the same true head ref.
    const artifactRows = await db.prisma.client.$queryRawUnsafe<
      { branch_name: string | null }[]
    >(
      `SELECT branch_name FROM artifacts
       WHERE kind = 'pull_request' AND pr_number = $1`,
      2000
    );
    assert.equal(artifactRows[0]?.branch_name, "fea-real-head");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("getPullRequests sources the branch from pull_requests, so an upgrade re-derive clears a stale artifact branch", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, 'inactive', $3, $3, 'claude')`,
      "stale-pr-session",
      "Stale PR session",
      "2026-06-07T10:00:00.000Z"
    );

    // Simulate an UPGRADING install: a foreign referenced PR whose artifact still
    // carries the pre-fix stale branch (the importing session's branch), while the
    // re-derived authoritative pull_requests row now correctly carries a NULL
    // branch (referenced PRs have no head ref). getPullRequests must show null.
    await insertSqlitePrArtifact(db, "stale-pr-session", {
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 321,
      title: "Foreign referenced PR",
      relation: "workspace",
    });
    await db.run(
      `UPDATE artifacts SET branch_name = 'stale-importing-session-branch'
       WHERE kind = 'pull_request' AND pr_number = 321`
    );
    await db.run(
      `INSERT INTO pull_requests
         (id, session_id, pr_url, pr_number, repo_full_name, branch_name,
          harness, observed_at, created_at)
       VALUES ($1, $2, $3, 321, $4, NULL, 'claude', $5, $5)`,
      "stale-pr-row",
      "stale-pr-session",
      "https://github.com/closedloop-ai/symphony-alpha/pull/321",
      "closedloop-ai/symphony-alpha",
      "2026-06-07T10:05:00.000Z"
    );

    // An enrichment-discovered PR: branch enrichment wrote the REAL head to the
    // artifact and linked the session, but there is NO pull_requests import row.
    // getPullRequests must fall back to the artifact branch (no regression).
    await insertSqlitePrArtifact(db, "stale-pr-session", {
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 654,
      title: "Enrichment-discovered PR",
      relation: "workspace",
    });
    await db.run(
      `UPDATE artifacts SET branch_name = 'enriched-real-head'
       WHERE kind = 'pull_request' AND pr_number = 654`
    );

    const prs = await db.dashboard.getPullRequests();
    const byNumber = new Map(prs.map((pr) => [pr.prNumber, pr.branchName]));

    // Repaired: the stale artifact branch is ignored in favor of the authoritative
    // (null) pull_requests branch.
    assert.equal(byNumber.get(321), null);
    // Fallback preserved: enrichment-only PR keeps its real head branch.
    assert.equal(byNumber.get(654), "enriched-real-head");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer persists OpenCode PR artifacts for delivery insights", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "opencode-pr-session",
      entrypoint: "opencode",
      artifacts: {
        prs: [
          {
            number: "411",
            url: "https://github.com/closedloop-ai/symphony-alpha/pull/411",
          },
        ],
        issues: [],
        repo: null,
      },
    };
    assert.equal(
      (await db.importer.importSession(session, "opencode")).skipped,
      false
    );

    const deliveryInsights = await db.dashboard.getInsights(
      InsightsSection.Delivery,
      "90"
    );
    assert.equal(deliveryInsights.kpis[0].value, 1);
    // FEA-2862: the OpenCode PR is captured (KPI = 1) but reference-only and
    // un-merged, so it does not appear in the merged-by-repository breakdown.
    assert.ok("prByRepo" in deliveryInsights.charts, DELIVERY_CHARTS_MESSAGE);
    assert.deepEqual(deliveryInsights.charts.prByRepo, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2862: prByRepo counts only in-session-created, merged PRs — not reference-only or un-merged ones", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-20T12:00:00.000Z",
  });

  try {
    // A session that owns some PR artifacts. The relation/state combinations
    // below are what distinguish a genuinely-merged authored PR from the
    // reference-only noise (competitor scans, CI `uses:` refs, fixture repos)
    // that FEA-2862 removed from the "Merged PRs by repository" chart.
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at)
       VALUES ('fea2862-session', 'inactive', $1, $1)`,
      "2026-06-16T10:00:00.000Z"
    );

    // (a) created + merged → the only PR that should appear.
    await insertSqlitePrArtifact(db, "fea2862-session", {
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 100,
      relation: "created",
      prState: "merged",
    });
    // (b) created but NOT merged (still open) → excluded by the merged filter.
    await insertSqlitePrArtifact(db, "fea2862-session", {
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 101,
      relation: "created",
      prState: "open",
    });
    // (c) merged but reference-only (relation='workspace', e.g. a competitor PR
    //     the session only viewed) → excluded by the created filter.
    await insertSqlitePrArtifact(db, "fea2862-session", {
      repoFullName: "competitor/tool",
      prNumber: 999,
      relation: "workspace",
      prState: "merged",
    });

    const delivery = await db.dashboard.getInsights(
      InsightsSection.Delivery,
      "90",
      new Date("2026-06-20T12:00:00.000Z")
    );

    assert.ok("prByRepo" in delivery.charts, DELIVERY_CHARTS_MESSAGE);
    assert.deepEqual(delivery.charts.prByRepo, [
      {
        key: "closedloop-ai/symphony-alpha",
        label: "closedloop-ai/symphony-alpha",
        value: 1,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite agent insights rejects unsafe persisted BIGINT token counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, name, status, started_at, updated_at, harness)
       VALUES ($1, $2, $3, $4, $5, $6)`,
      "unsafe-insights-session",
      "Unsafe insights session",
      "inactive",
      "2026-06-07T10:00:00.000Z",
      "2026-06-07T10:01:00.000Z",
      "claude"
    );
    await db.run(
      `INSERT INTO token_usage (
         session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
         raw_input, raw_output, raw_cache_read, raw_cache_write
       )
       VALUES ($1, $2, $3, 1, 1, 1, $3, 1, 1, 1)`,
      "unsafe-insights-session",
      "claude-opus-4-8",
      "9007199254740992"
    );

    // Engine difference (SQLite → libSQL): the unsafe BIGINT is still rejected,
    // but the rejection moves earlier. SQLite returned bigint as a string and
    // `readStorageTokenCount` threw InvalidTokenCountError. libSQL with
    // intMode:"number" throws a RangeError at the driver while decoding the row
    // (before the value reaches the token validator). Either way the unsafe
    // value never silently corrupts the analytics — assert it is rejected.
    await assert.rejects(
      () => db.dashboard.getInsights(InsightsSection.Agents, "90"),
      (error: unknown) =>
        error instanceof InvalidTokenCountError || error instanceof RangeError
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite metered usage rows include only metered sessions within the cutoff", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES
        ($1, 'inactive', $2, $2, 'claude', 'api'),
        ($3, 'inactive', $4, $4, 'claude', 'subscription_unknown'),
        ($5, 'inactive', $6, $6, 'claude', 'api')`,
      "metered-in-window",
      "2026-05-20T10:00:00.000Z",
      "subscription-in-window",
      "2026-05-20T10:00:00.000Z",
      "metered-before-cutoff",
      "2025-01-01T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage (
        session_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, raw_input, raw_output,
        raw_cache_read, raw_cache_write, created_at, updated_at
       )
       VALUES
        ($1, 'claude-opus-4-5', 1500, 300, 75, 15, 1500, 300, 75, 15, $2, $2),
        ($3, 'claude-opus-4-5', 1000, 200, 0, 0, 1000, 200, 0, 0, $2, $2),
        ($4, 'claude-opus-4-5', 1, 2, 3, 4, 1, 2, 3, 4, $2, $2)`,
      "metered-in-window",
      "2026-05-20T10:00:00.000Z",
      "subscription-in-window",
      "metered-before-cutoff"
    );

    const rows = await db.loadMeteredUsageRows("2026-04-23T00:00:00.000Z");

    assert.equal(rows.length, 1);
    assert.equal(rows[0].sessionId, "metered-in-window");
    assert.equal(rows[0].billingMode, "api");
    assert.equal(rows[0].inputTokens, 1500);
    assert.equal(rows[0].outputTokens, 300);
    assert.equal(rows[0].cacheReadTokens, 75);
    assert.equal(rows[0].cacheWriteTokens, 15);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite token analytics supports sums above PostgreSQL integer range", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at, harness, billing_mode)
       VALUES ($1, 'inactive', $2, $2, 'codex', 'api')`,
      "large-token-session",
      "2026-06-07T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_usage (
        session_id, model, input_tokens, output_tokens,
        cache_read_tokens, cache_write_tokens, raw_input, raw_output,
        raw_cache_read, raw_cache_write, created_at, updated_at
       )
       VALUES
        ($1, 'model-a', 1500000000, 900000000, 800000000, 700000000, 1500000000, 900000000, 800000000, 700000000, $2, $2),
        ($1, 'model-b', 1500000000, 900000000, 800000000, 700000000, 1500000000, 900000000, 800000000, 700000000, $2, $2)`,
      "large-token-session",
      "2026-06-07T10:00:00.000Z"
    );
    await db.run(
      `INSERT INTO token_events (session_id, model, created_at, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens)
       VALUES
        ($1, 'model-a', $2, 1500000000, 900000000, 800000000, 700000000),
        ($1, 'model-b', $2, 1500000000, 900000000, 800000000, 700000000)`,
      "large-token-session",
      "2026-06-07T10:00:00.000Z"
    );

    const analytics = await db.dashboard.getAnalytics(
      new Date("2026-06-07T12:00:00.000Z")
    );
    const summary = await db.getSummary();
    const detail = await db.sessions.getDetailsById("large-token-session");

    assert.equal(analytics.tokens.totalInputTokens, 3_000_000_000);
    assert.equal(analytics.tokens.totalOutputTokens, 1_800_000_000);
    assert.equal(analytics.tokens.totalCacheReadTokens, 1_600_000_000);
    assert.equal(analytics.tokens.totalCacheWriteTokens, 1_400_000_000);
    assert.equal(summary.totalTokens, 4_800_000_000);
    assert.equal(detail?.totalTokens, 4_800_000_000);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite token reconciliation overwrites with the latest full derivation", async () => {
  // FEA-1459 (PR #1511 review): replace() is a plain overwrite. Both callers
  // re-derive FULL totals from the entire (append-only) transcript on every
  // call, so the latest derivation is authoritative — including when it is
  // SMALLER than the stored row (v1-inflated rows being healed by the v2
  // deduped parser). The old counter-reset accumulation stacked the new
  // value on top of the old one in exactly that case.
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.tokenUsage.replace(
      "s1",
      "m1",
      { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
      "2026-06-02T00:00:00.000Z"
    );
    await db.tokenUsage.replace(
      "s1",
      "m1",
      { input: 150, output: 70, cacheRead: 20, cacheWrite: 5 },
      "2026-06-02T00:00:00.000Z"
    );
    let rows = await db.tokenUsage.getBySession("s1");
    assert.equal(rows[0].inputTokens, 150);
    assert.equal(rows[0].outputTokens, 70);
    assert.equal(rows[0].cacheReadTokens, 20);
    assert.equal(rows[0].cacheWriteTokens, 5);

    // A smaller re-derivation (deduped reimport) overwrites — never stacks.
    await db.tokenUsage.replace(
      "s2",
      "m1",
      { input: 150, output: 80, cacheRead: 0, cacheWrite: 0 },
      "2026-06-02T00:00:00.000Z"
    );
    await db.tokenUsage.replace(
      "s2",
      "m1",
      { input: 30, output: 10, cacheRead: 0, cacheWrite: 0 },
      "2026-06-02T00:00:00.000Z"
    );
    rows = await db.tokenUsage.getBySession("s2");
    assert.equal(rows[0].inputTokens, 30);
    assert.equal(rows[0].outputTokens, 10);

    await db.tokenUsage.replace(
      "s3",
      "m1",
      { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
      "2026-06-02T00:00:00.000Z"
    );
    assert.equal((await db.tokenUsage.getBySession("s3")).length, 0);

    await db.tokenUsage.replace(
      "s4",
      "m1",
      { input: 100, output: 0, cacheRead: 0, cacheWrite: 0 },
      "2026-06-02T00:00:00.000Z"
    );
    await db.tokenUsage.replace(
      "s4",
      "m2",
      { input: 200, output: 0, cacheRead: 0, cacheWrite: 0 },
      "2026-06-02T00:00:00.000Z"
    );
    const byModel = Object.fromEntries(
      (await db.tokenUsage.getBySession("s4")).map((row) => [
        row.model,
        row.inputTokens,
      ])
    );
    assert.deepEqual(byModel, { m1: 100, m2: 200 });
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite sessions pagination preserves details, filters, escaping, and deterministic ordering", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    for (let i = 1; i <= 5; i += 1) {
      await insertSqliteSession(db, `s${i}`, {
        startedAt: `2024-03-09T16:0${i}:00.000Z`,
      });
    }
    await db.run(
      `INSERT INTO agents (id, session_id, name, type, status, started_at, updated_at)
       VALUES
        ('a4-main', 's4', 'main', 'main', 'completed', '2024-03-09T16:04:00.000Z', '2024-03-09T16:04:00.000Z'),
        ('a4-sub', 's4', 'sub', 'subagent', 'completed', '2024-03-09T16:04:01.000Z', '2024-03-09T16:04:01.000Z')`
    );
    await db.run(
      `INSERT INTO events (id, session_id, event_type, created_at)
       VALUES
        ('e4-1', 's4', 'Stop', '2024-03-09T16:04:00.000Z'),
        ('e4-2', 's4', 'Stop', '2024-03-09T16:04:01.000Z'),
        ('e4-3', 's4', 'Stop', '2024-03-09T16:04:02.000Z')`
    );
    await db.tokenUsage.replace(
      "s4",
      "gpt-5",
      { input: 100, output: 25, cacheRead: 0, cacheWrite: 0 },
      "2024-03-09T16:04:00.000Z"
    );

    const page = await db.sessions.getPage({ limit: 2, offset: 1 });
    assert.equal(page.total, 5);
    assert.deepEqual(
      page.sessions.map((session) => session.id),
      ["s4", "s3"]
    );
    assert.equal(page.sessions[0].agentCount, 2);
    assert.equal(page.sessions[0].eventCount, 3);
    assert.equal(page.sessions[0].totalTokens, 125);

    const clamped = await db.sessions.getPage({ limit: 1000, offset: -10 });
    assert.equal(clamped.limit, 100);
    assert.equal(clamped.offset, 0);

    await insertSqliteSession(db, "waiting-1", {
      name: "Needs Input",
      cwd: "/repo/design-system",
      status: "active",
      startedAt: "2024-03-09T16:06:00.000Z",
      awaitingInputSince: "2024-03-09T16:06:30.000Z",
    });
    // FEA-3149: a non-terminal, awaiting-input session whose `ended_at` is set
    // must NOT surface in the Waiting facet (cloud parity — its projection
    // reports PendingApproval only while `!sessionEndedAt`). Before the fix the
    // read-store predicate lacked the `ended_at IS NULL` guard.
    await insertSqliteSession(db, "waiting-ended", {
      name: "Ended While Awaiting",
      status: "active",
      startedAt: "2024-03-09T16:06:45.000Z",
      awaitingInputSince: "2024-03-09T16:06:50.000Z",
      endedAt: "2024-03-09T16:06:55.000Z",
    });
    await insertSqliteSession(db, "literal-percent", {
      name: "100% done",
      startedAt: "2024-03-09T16:07:00.000Z",
    });
    await insertSqliteSession(db, "literal-underscore", {
      name: "task_runner",
      startedAt: "2024-03-09T16:08:00.000Z",
    });
    assert.deepEqual(
      (await db.sessions.getPage({ status: "waiting" })).sessions.map(
        (session) => session.id
      ),
      // "waiting-ended" is excluded by the FEA-3149 `ended_at IS NULL` guard.
      ["waiting-1"]
    );
    assert.deepEqual(
      (await db.sessions.getPage({ q: "%" })).sessions.map(
        (session) => session.id
      ),
      ["literal-percent"]
    );
    assert.deepEqual(
      (await db.sessions.getPage({ q: "_" })).sessions.map(
        (session) => session.id
      ),
      ["literal-underscore"]
    );

    const sharedTime = "2024-03-09T17:00:00.000Z";
    for (const id of ["aaa", "bbb", "ccc", "ddd", "eee"]) {
      await insertSqliteSession(db, id, { startedAt: sharedTime });
    }
    const page1 = await db.sessions.getPage({ limit: 2, offset: 0 });
    const page2 = await db.sessions.getPage({ limit: 2, offset: 2 });
    const page3 = await db.sessions.getPage({ limit: 2, offset: 4 });
    assert.deepEqual(
      [...page1.sessions, ...page2.sessions, ...page3.sessions].map(
        (session) => session.id
      ),
      ["eee", "ddd", "ccc", "bbb", "aaa", "literal-underscore"]
    );

    const kanban = await db.sessions.getKanbanPages(
      ["running", "waiting", "inactive"],
      25
    );
    assert.deepEqual(
      kanban.waiting.sessions.map((session) => session.id),
      // FEA-3149: the kanban Waiting bucket (same predicate) also excludes the
      // ended-but-non-terminal awaiting-input session.
      ["waiting-1"]
    );
    assert.ok(kanban.inactive.sessions.length > 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// perf/desktop-list-explicit-columns: the session list/detail reads now project
// an explicit column list instead of `SELECT *` / `s.*`, dropping the large
// unused JSONB (`trace_phase_sources`, `throttle_sources`, `correction_sources`)
// and `cost_*` / `data_revision` columns. This guards that every consumed
// `SessionRow` field still maps identically across every read path even when
// those dropped columns are populated on the row.
test("SQLite session list reads map every SessionRow field with explicit projection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // Active session, fully populated INCLUDING the columns the projection
    // intentionally drops, to prove their presence does not affect the mapping.
    await db.run(
      `INSERT INTO sessions (
         id, name, status, cwd, model, started_at, updated_at, ended_at,
         awaiting_input_since, metadata, harness, billing_mode,
         user_id, organization_id,
         trace_phase_sources, throttle_sources, correction_sources,
         cost_usd_estimated, cost_currency, cost_source, data_revision
       )
       VALUES (
         'proj-active', 'Active Projection', 'active', '/work/proj-active',
         'claude-sonnet-4-5', '2026-06-07T10:00:00.000Z',
         '2026-06-07T10:05:00.000Z', NULL, '2026-06-07T10:04:00.000Z',
         '{"k":"v"}', 'claude', 'metered_api', 'u-proj', 'org-proj',
         '[{"phase":"plan"}]', '[{"throttle":1}]', '[{"correction":2}]',
         1.23, 'USD', 'estimate', 7
       )`
    );
    // Historical session to exercise the terminal-status read path.
    await db.run(
      `INSERT INTO sessions (
         id, name, status, cwd, model, started_at, updated_at, ended_at,
         awaiting_input_since, metadata, harness, billing_mode,
         user_id, organization_id, trace_phase_sources
       )
       VALUES (
         'proj-done', 'Done Projection', 'inactive', '/work/proj-done',
         'gpt-5', '2026-06-07T09:00:00.000Z', '2026-06-07T09:10:00.000Z',
         '2026-06-07T09:10:00.000Z', NULL, '{"done":true}', 'codex', 'api',
         'u-proj', 'org-proj', '[{"phase":"impl"}]'
       )`
    );

    const expectedActive = {
      id: "proj-active",
      name: "Active Projection",
      status: "active",
      cwd: "/work/proj-active",
      model: "claude-sonnet-4-5",
      startedAt: "2026-06-07T10:00:00.000Z",
      updatedAt: "2026-06-07T10:05:00.000Z",
      endedAt: null,
      awaitingInputSince: "2026-06-07T10:04:00.000Z",
      metadata: '{"k":"v"}',
      harness: "claude",
      billingMode: "metered_api",
      userId: "u-proj",
      organizationId: "org-proj",
    };
    // `Object.keys` widens to `string[]`; these keys are known, so the
    // detail-row lookups below stay typed against `SessionWithAgents`.
    type ExpectedKey = keyof typeof expectedActive;
    const expectedActiveKeys = Object.keys(expectedActive) as ExpectedKey[];

    // getById — explicit plain-column projection.
    assert.deepEqual(await db.sessions.getById("proj-active"), expectedActive);

    // getActive — explicit plain-column projection, non-terminal only.
    const active = await db.sessions.getActive();
    assert.deepEqual(
      active.map((s) => s.id),
      ["proj-active"]
    );
    assert.deepEqual(active[0], expectedActive);

    // getAll — explicit plain-column projection, all rows.
    const all = await db.sessions.getAll();
    assert.deepEqual(
      all.find((s) => s.id === "proj-active"),
      expectedActive
    );

    // getActiveWithDetails — explicit s.-aliased projection + aggregate counts.
    const activeDetails = await db.sessions.getActiveWithDetails();
    const activeDetail = activeDetails.find((s) => s.id === "proj-active");
    assert.ok(activeDetail);
    // Every base SessionRow field maps identically alongside the detail fields.
    for (const key of expectedActiveKeys) {
      assert.deepEqual(
        activeDetail[key],
        expectedActive[key],
        `getActiveWithDetails.${key}`
      );
    }
    assert.equal(activeDetail.agentCount, 0);
    assert.equal(activeDetail.eventCount, 0);
    assert.equal(activeDetail.totalTokens, 0);

    // getHistoricalWithDetails — explicit s.-aliased projection, terminal only.
    const historical = await db.sessions.getHistoricalWithDetails();
    assert.deepEqual(
      historical.map((s) => s.id),
      ["proj-done"]
    );
    assert.equal(historical[0].metadata, '{"done":true}');
    assert.equal(historical[0].endedAt, "2026-06-07T09:10:00.000Z");

    // getPage — explicit s.-aliased projection through the page path.
    const page = await db.sessions.getPage({ limit: 50, offset: 0 });
    const pageActive = page.sessions.find((s) => s.id === "proj-active");
    assert.ok(pageActive);
    for (const key of expectedActiveKeys) {
      assert.deepEqual(pageActive[key], expectedActive[key], `getPage.${key}`);
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite lifecycle, store, and sync source preserve identity columns", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    getUserIdentity: () => ({
      userId: "u-sqlite",
      organizationId: "org-sqlite",
    }),
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      {
        session_id: "identity-session",
        cwd: "/workspace/project",
      },
      "claude"
    );

    const session = await db.sessions.getById("identity-session");
    assert.equal(session?.userId, "u-sqlite");
    assert.equal(session?.organizationId, "org-sqlite");

    const synced = await db.syncSource.loadSyncedSessions(
      ["identity-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    assert.equal(synced[0].userId, "u-sqlite");
    assert.equal(synced[0].organizationId, "org-sqlite");
    // FEA-1459: deviceTimeZone populated from the machine's IANA timezone
    assert.equal(typeof synced[0].deviceTimeZone, "string");
    assert.ok(
      synced[0].deviceTimeZone!.length > 0,
      "deviceTimeZone should be a non-empty IANA timezone string"
    );
    assert.deepEqual(synced[0].prRefs, []);
    assert.deepEqual(synced[0].tracePhaseSources, []);
    assert.deepEqual(synced[0].throttleSources, []);
    assert.deepEqual(synced[0].correctionSources, []);
    assert.deepEqual(synced[0].phases, []);
    assert.deepEqual(synced[0].phaseIterations, {});
    assert.deepEqual(synced[0].phaseLoopbacks, []);
    assert.deepEqual(synced[0].throttles, []);

    await insertSqliteSession(db, "anonymous-session", {
      startedAt: "2026-06-07T12:05:00.000Z",
    });
    const anonymous = await db.sessions.getById("anonymous-session");
    assert.equal(anonymous?.userId, null);
    assert.equal(anonymous?.organizationId, null);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3591: recomputeSessionLastActivityAt floors last_activity_at at started_at,
// so the denormalized value can never precede the session start — even when a
// resumed/continued run inherits events whose created_at predates its resume
// started_at. Prior to the floor these rows (63 in the curation sweep) violated
// the `last_activity_at >= started_at` invariant the cloud read path documents,
// and — since FEA-3580 derives endedAt from last_activity_at — produced negative
// durations. Normal sessions (events at/after started_at) still report the real
// MAX(events.created_at), so the floor is transparent for well-formed data.
test("recomputeSessionLastActivityAt floors last_activity_at at started_at (FEA-3591)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-07-14T12:00:00.000Z",
  });

  try {
    // "resumed": a continuation run whose started_at is the resume time but whose
    // events were inherited from the parent transcript ~2.2h BEFORE the resume.
    // MAX(events.created_at) is earlier than started_at → the floor must clamp it.
    const resumeStart = "2026-07-14T01:23:24.000Z";
    await insertSqliteSession(db, "resumed", { startedAt: resumeStart });
    await insertSqliteEvent(db, "resumed", "2026-07-13T23:07:02.000Z"); // pre-start
    await insertSqliteEvent(db, "resumed", "2026-07-13T23:00:00.000Z"); // pre-start

    // "normal": events at/after started_at — the floor is a no-op, real MAX wins.
    const normalStart = "2026-07-14T00:00:00.000Z";
    await insertSqliteSession(db, "normal", { startedAt: normalStart });
    await insertSqliteEvent(db, "normal", "2026-07-14T02:00:00.000Z"); // MAX
    await insertSqliteEvent(db, "normal", "2026-07-14T01:00:00.000Z");

    const stored = await db.prisma.client.$queryRawUnsafe<
      { id: string; started_at: string; last_activity_at: string }[]
    >("SELECT id, started_at, last_activity_at FROM sessions ORDER BY id");
    const byId = new Map(stored.map((r) => [r.id, r]));

    // Floored: last_activity_at == started_at, NOT the earlier pre-start event MAX.
    assert.equal(byId.get("resumed")?.last_activity_at, resumeStart);
    // Normal: unchanged — the real MAX(events.created_at).
    assert.equal(
      byId.get("normal")?.last_activity_at,
      "2026-07-14T02:00:00.000Z"
    );

    // The invariant the ticket asserts: no row may have last_activity < started.
    for (const row of stored) {
      assert.ok(
        row.last_activity_at >= row.started_at,
        `${row.id}: last_activity_at (${row.last_activity_at}) must be >= started_at (${row.started_at})`
      );
    }
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3591: end-to-end boot ordering — the awaited floor heal runs BEFORE the
// orphan sweep and the retention sweep, so (a) pre-existing violations are
// repaired no matter how the rows got there (rebuild-unreachable rows
// included), (b) a stale active is still swept afterwards (the heal must not
// bump its updated_at) and its ended_at is the HEALED activity, and (c) the
// terminal row's correction is stamped with a cursor-visible ISO watermark.
test("boot heals last_activity_at floor violations before the orphan and retention sweeps (FEA-3591)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const seedNow = "2026-07-14T02:00:00.000Z";
  const bootNow = "2026-07-14T12:00:00.000Z";
  const resumeStart = "2026-07-14T01:00:00.000Z";
  const inheritedActivity = "2026-07-13T23:00:00.000Z";

  const db1 = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => seedNow,
  });
  await insertSqliteSession(db1, "boot-bad-completed", {
    status: "inactive",
    startedAt: resumeStart,
    updatedAt: "2026-07-10T00:00:00.000Z",
  });
  // updated_at 10h before bootNow → stale under the 180-min orphan cutoff.
  await insertSqliteSession(db1, "boot-stale-active", {
    status: "active",
    startedAt: resumeStart,
    updatedAt: seedNow,
  });
  // Corrupt the denormalized key into the pre-floor stored shape (the
  // curation-sweep signature: inherited activity ~2h before the resume start).
  await db1.run(
    "UPDATE sessions SET last_activity_at = $1 WHERE id IN ($2, $3)",
    inheritedActivity,
    "boot-bad-completed",
    "boot-stale-active"
  );
  await db1.close();

  const db2 = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => bootNow,
  });
  try {
    const rows = await db2.prisma.client.$queryRawUnsafe<
      {
        id: string;
        status: string;
        started_at: string;
        last_activity_at: string;
        ended_at: string | null;
        updated_at: string;
      }[]
    >(
      "SELECT id, status, started_at, last_activity_at, ended_at, updated_at FROM sessions ORDER BY id"
    );
    const byId = new Map(rows.map((r) => [r.id, r]));

    const completed = byId.get("boot-bad-completed");
    assert.equal(completed?.last_activity_at, resumeStart);
    assert.equal(completed?.updated_at, chunkWatermark(bootNow, 0));

    const sweptActive = byId.get("boot-stale-active");
    assert.equal(sweptActive?.status, "inactive");
    assert.equal(sweptActive?.last_activity_at, resumeStart);
    assert.equal(sweptActive?.ended_at, resumeStart);
    assert.equal(sweptActive?.updated_at, bootNow);

    for (const row of rows) {
      assert.ok(
        row.last_activity_at >= row.started_at,
        `${row.id}: last_activity_at (${row.last_activity_at}) must be >= started_at (${row.started_at})`
      );
    }
  } finally {
    await db2.close();
    await rm(dir, { recursive: true, force: true });
  }
});

/**
 * Metadata that survives compaction at full size: each string sits at the
 * 1024-char cap, each array at the 100-item cap, and the key count is under the
 * 80-key cap, so compaction cannot shrink it. ~4 MB compacted — genuinely
 * un-shippable, which is the only thing the preflight may dead-letter.
 */
function buildUncompactableMetadata(): string {
  return JSON.stringify(
    Object.fromEntries(
      Array.from({ length: 40 }, (_, index) => [
        `bulk${index}`,
        Array.from({ length: 100 }, () => "x".repeat(1024)),
      ])
    )
  );
}

/**
 * The real shape of a long session's metadata: thousands of conversation turns
 * under `messages`. Raw this is ~1 MB, but compaction keeps only the first 100
 * messages with 160-char `text` previews, so it ships comfortably.
 */
function buildChattyMetadata(): string {
  return JSON.stringify({
    messages: Array.from({ length: 2000 }, (_, index) => ({
      role: index % 2 === 0 ? "user" : "assistant",
      text: "y".repeat(400),
      timestamp: "2026-06-07T12:00:00.000Z",
    })),
  });
}

test("SQLite sync source preflights locally oversized metadata payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await insertSqliteSession(db, "metadata-oversized", {
      metadata: buildUncompactableMetadata(),
    });
    await insertSqliteSession(db, "healthy-session");

    const oversized = await db.syncSource.findLocallyOversizedSessions?.(
      ["metadata-oversized", "healthy-session"],
      SESSION_PAYLOAD_BYTE_CAP
    );

    assert.deepEqual(
      oversized?.map((row) => row.id),
      ["metadata-oversized"]
    );
    assert.ok((oversized?.[0]?.payloadBytes ?? 0) > SESSION_PAYLOAD_BYTE_CAP);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite sync source preflight sizes the sanitized session, not the raw row", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // Raw metadata is far over the cap, but compaction brings it well under it,
    // so the real sync path ships this session. The preflight is a lower bound
    // on that path and must not dead-letter it (regression: sizing the raw row
    // silently dropped every metadata-heavy session).
    const chattyMetadata = buildChattyMetadata();
    assert.ok(Buffer.byteLength(chattyMetadata) > SESSION_PAYLOAD_BYTE_CAP);
    await insertSqliteSession(db, "chatty-session", {
      metadata: chattyMetadata,
    });

    const oversized = await db.syncSource.findLocallyOversizedSessions?.(
      ["chatty-session"],
      SESSION_PAYLOAD_BYTE_CAP
    );

    assert.deepEqual(oversized, []);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite sync source normalizes bounded explicit Session Trace sources only", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      {
        session_id: "source-normalization-session",
        cwd: "/workspace/project",
      },
      "claude"
    );

    await db.run(
      `INSERT INTO events
         (id, session_id, event_type, tool_name, summary, data, created_at)
       VALUES
         ($1, $2, 'PreToolUse', 'Read', 'forged tool input', $3, $4),
         ($5, $2, 'loop.perf.phase', NULL, 'invalid phase', $6, $4),
         ($7, $2, 'provider.rate_limit', NULL, 'invalid throttle', $8, $4),
         ($9, $2, 'provider.rate_limit', NULL, 'valid throttle', $10, $4),
         ($11, $2, 'manual_regression', NULL, 'valid correction', $12, $4)`,
      "forged-tool",
      "source-normalization-session",
      JSON.stringify({
        phaseKey: "forged",
        statusCode: 429,
        kind: "explicit_correction",
      }),
      "2026-06-16T10:01:00.000Z",
      "invalid-phase",
      JSON.stringify({
        phaseKey: "invalid",
        startedAt: "not-a-date",
      }),
      "invalid-throttle",
      JSON.stringify({
        provider: "codex",
        observedAt: "not-a-date",
        statusCode: 429,
      }),
      "valid-throttle",
      JSON.stringify({
        provider: "codex".repeat(100),
        observedAt: "2026-06-16T10:04:00.000Z",
        statusCode: 429,
      }),
      "valid-correction",
      JSON.stringify({
        kind: SessionTraceCorrectionKind.ManualRegression,
        observedAt: "2026-06-16T10:05:00.000Z",
      })
    );

    for (
      let index = 0;
      index < SESSION_TRACE_SOURCE_LIMITS.phaseSources + 1;
      index += 1
    ) {
      await db.run(
        `INSERT INTO events
           (id, session_id, event_type, tool_name, summary, data, created_at)
         VALUES ($1, $2, 'loop.perf.phase', NULL, 'phase', $3, $4)`,
        `phase-${index}`,
        "source-normalization-session",
        JSON.stringify({
          phaseKey:
            index === 0
              ? "x".repeat(SESSION_TRACE_SOURCE_LIMITS.sourceText + 20)
              : `phase-${index}`,
          startedAt: `2026-06-16T10:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`,
        }),
        `2026-06-16T10:${String(10 + (index % 40)).padStart(2, "0")}:00.000Z`
      );
    }

    const [synced] = await db.syncSource.loadSyncedSessions(
      ["source-normalization-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );

    assert.equal(synced?.prRefs?.length, 0);
    assert.equal(
      synced?.tracePhaseSources?.length,
      SESSION_TRACE_SOURCE_LIMITS.phaseSources
    );
    assert.equal(
      synced?.tracePhaseSources?.[0]?.phaseKey.length,
      SESSION_TRACE_SOURCE_LIMITS.sourceText
    );
    assert.equal(
      synced?.tracePhaseSources?.some((source) => source.phaseKey === "forged"),
      false
    );
    assert.equal(
      synced?.tracePhaseSources?.some(
        (source) => source.phaseKey === "invalid"
      ),
      false
    );
    assert.equal(
      synced?.tracePhaseSources?.every(
        (source) => source.sourceType === SessionTracePhaseSourceType.LoopPerf
      ),
      true
    );
    assert.equal(synced?.throttleSources?.length, 1);
    assert.equal(
      synced?.throttleSources?.[0]?.provider.length,
      SESSION_TRACE_SOURCE_LIMITS.sourceText
    );
    assert.equal(synced?.correctionSources?.length, 1);
    assert.equal(
      synced?.correctionSources?.[0]?.kind,
      SessionTraceCorrectionKind.ManualRegression
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite sync source caps the wire markers array at the source limit", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    await db.processEvent(
      "SessionStart",
      {
        session_id: "marker-cap-session",
        cwd: "/workspace/project",
      },
      "claude"
    );

    // One prompt marker per UserMessage event; exceed the cloud Zod cap so an
    // uncapped payload would fail `session_invalid` and lose the whole session.
    for (
      let index = 0;
      index < SESSION_TRACE_SOURCE_LIMITS.markers + 1;
      index += 1
    ) {
      const minute = String(Math.floor(index / 60)).padStart(2, "0");
      const second = String(index % 60).padStart(2, "0");
      const createdAt = `2026-06-16T10:${minute}:${second}.000Z`;
      await db.run(
        `INSERT INTO events
           (id, session_id, event_type, tool_name, summary, data, created_at)
         VALUES ($1, $2, 'UserMessage', NULL, 'Prompt', NULL, $3)`,
        `marker-${index}`,
        "marker-cap-session",
        createdAt
      );
    }

    const [synced] = await db.syncSource.loadSyncedSessions(
      ["marker-cap-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );

    assert.equal(synced?.markers?.length, SESSION_TRACE_SOURCE_LIMITS.markers);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite sync source keeps same-number PRs from different repositories", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    await insertSqliteSession(db, "same-number-pr-session", {
      cwd: "/workspace/project",
      startedAt: "2026-06-16T10:00:00.000Z",
    });
    // Legacy metadata.artifacts.prs is intentionally ignored (FEA-1899) — a
    // referenced PR here must NOT surface; only artifact-linked PRs do.
    await db.run(
      "UPDATE sessions SET metadata = $1 WHERE id = $2",
      JSON.stringify({
        artifacts: {
          prs: [
            {
              number: 99,
              title: "Legacy metadata PR (must not surface)",
              status: SessionPrLifecycleStatus.Open,
            },
          ],
        },
      }),
      "same-number-pr-session"
    );
    await insertSqlitePrArtifact(db, "same-number-pr-session", {
      repoFullName: "closedloop-ai/repo-a",
      prNumber: 17,
      title: "Repo A PR",
      prState: PullRequestState.Open,
      observedAt: "2026-06-16T10:35:00.000Z",
    });
    await insertSqlitePrArtifact(db, "same-number-pr-session", {
      repoFullName: "closedloop-ai/repo-b",
      prNumber: 17,
      title: "Repo B PR",
      prState: PullRequestState.Merged,
      observedAt: "2026-06-16T10:36:00.000Z",
    });

    const [synced] = await db.syncSource.loadSyncedSessions(
      ["same-number-pr-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );

    assert.deepEqual(
      synced?.prs?.map((pr) => [pr.num, pr.title, pr.status]).sort(),
      [
        [17, "Repo A PR", SessionPrLifecycleStatus.Open],
        [17, "Repo B PR", SessionPrLifecycleStatus.Merged],
      ].sort()
    );
    assert.equal(
      Object.hasOwn(synced?.prs?.[0] ?? {}, "repositoryFullName"),
      false
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer exposes Claude transcript PR refs through synced prs and prRefs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const sessionId = "claude-pr-import-session";
  const transcript = path.join(dir, `${sessionId}.jsonl`);
  const prUrl = "https://github.com/closedloop-ai/symphony-alpha/pull/3210";
  await writeFile(
    transcript,
    `${[
      JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-16T10:01:00.000Z",
        cwd: "/workspace/symphony-alpha",
        gitBranch: "fea-2381-claude-pr",
        message: {
          model: "claude-sonnet-4-5",
          usage: {
            input_tokens: 12,
            output_tokens: 6,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
          content: [
            {
              type: "tool_use",
              id: "toolu_claude_pr_create",
              name: "Bash",
              input: { command: "gh pr create --fill" },
            },
          ],
        },
      }),
      JSON.stringify({
        type: "user",
        timestamp: "2026-06-16T10:02:00.000Z",
        message: {
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_claude_pr_create",
              content: `Created pull request ${prUrl}`,
            },
          ],
        },
      }),
    ].join("\n")}\n`,
    "utf8"
  );
  const parsed = await parseClaudeFile(transcript);
  assert.ok(parsed);
  assert.deepEqual(parsed.artifacts.prs, [
    {
      number: "3210",
      repo: "closedloop-ai/symphony-alpha",
      url: prUrl,
    },
  ]);

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    assert.equal(
      (await db.importer.importSession(parsed, "claude")).skipped,
      false
    );

    const [synced] = await db.syncSource.loadSyncedSessions(
      [parsed.sessionId],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );

    assert.deepEqual(
      synced?.prs?.map((pr) => [pr.num, pr.status]),
      [[3210, SessionPrLifecycleStatus.Unknown]]
    );
    assert.deepEqual(synced?.prRefs, [
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        prNumber: 3210,
        prUrl,
        relationType: SessionPrRelationType.Created,
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: "2026-06-16T10:01:00.000Z",
            evidenceId: "desktop-artifact-link:d922aa13b3fe3833",
          },
        ],
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer exposes Codex transcript PR refs through synced prs and prRefs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const sessionsDir = path.join(dir, "sessions");
  const rolloutDir = path.join(sessionsDir, "2026", "06", "16");
  const sessionId = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";
  const prUrl = "https://github.com/closedloop-ai/symphony-alpha/pull/3211";
  await mkdir(rolloutDir, { recursive: true });
  const rolloutPath = path.join(
    rolloutDir,
    `rollout-2026-06-16T10-10-00-${sessionId}.jsonl`
  );
  await writeFile(
    rolloutPath,
    `${[
      JSON.stringify({
        timestamp: "2026-06-16T10:10:00.000Z",
        type: "session_meta",
        payload: {
          id: sessionId,
          cwd: "/workspace/symphony-alpha",
          cli_version: "0.40.0",
          source: "exec",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-16T10:10:00.000Z",
        type: "turn_context",
        payload: {
          model: "gpt-5-codex",
          cwd: "/workspace/symphony-alpha",
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-16T10:10:01.000Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_begin",
          server: "github",
          method: "create_pull_request",
          arguments: { title: "Codex PR" },
        },
      }),
      JSON.stringify({
        timestamp: "2026-06-16T10:10:02.000Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          output: { url: prUrl },
        },
      }),
    ].join("\n")}\n`,
    "utf8"
  );
  const collector = createCodexCollector({
    sessionsDir,
    archivedDir: path.join(dir, "archive"),
    listSources: () => [rolloutPath],
  });
  const [parsed] = await collector.parse(rolloutPath);
  assert.ok(parsed);
  assert.deepEqual(parsed.artifacts.prs, [
    {
      number: "3211",
      repo: "closedloop-ai/symphony-alpha",
      url: prUrl,
    },
  ]);

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    assert.equal(
      (await db.importer.importSession(parsed, "codex")).skipped,
      false
    );

    const [synced] = await db.syncSource.loadSyncedSessions([sessionId], {
      attributionByCwd: new Map(),
      launchMetadataRootByCwd: new Map(),
      repoFullNameByPath: new Map(),
    });

    assert.deepEqual(
      synced?.prs?.map((pr) => [pr.num, pr.status]),
      [[3211, SessionPrLifecycleStatus.Unknown]]
    );
    assert.deepEqual(synced?.prRefs, [
      {
        repositoryFullName: "closedloop-ai/symphony-alpha",
        prNumber: 3211,
        prUrl,
        relationType: SessionPrRelationType.Created,
        branchLifecycleEvents: [
          {
            kind: BranchLifecycleBoundaryKind.PrRaised,
            observedAt: "2026-06-16T10:10:01.000Z",
            evidenceId: "desktop-artifact-link:d6f19d697557af28",
          },
        ],
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer skips malformed normalized PR identities in synced prs and prRefs", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    const session: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "malformed-pr-import-session",
      artifacts: {
        prs: [
          { number: "not-a-number", repo: "closedloop-ai/symphony-alpha" },
          { number: "3212" },
        ],
        issues: [],
        repo: null,
      },
    };
    assert.equal(
      (await db.importer.importSession(session, "claude")).skipped,
      false
    );

    const [synced] = await db.syncSource.loadSyncedSessions(
      [session.sessionId],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );

    assert.equal(synced?.prs?.length ?? 0, 0);
    assert.equal(synced?.prRefs?.length ?? 0, 0);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite upgraded stores add Session Trace columns before local projection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");

  // Engine/model change (SQLite → libSQL): the old test pre-created a legacy
  // SQLite schema and relied on the migration runner's baseline-upgrade path to
  // ALTER in the Session Trace columns. Under SQLite every install migrates
  // from scratch (baselining is moot — see fea-sqlite-migration.md), so the
  // freshly migrated schema already carries the trace columns. We open the
  // migrated DB directly and seed the same rows through it; the column
  // assertion below proves the columns exist post-migration.
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-16T10:45:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions
         (id, name, status, cwd, model, started_at, updated_at, ended_at,
          awaiting_input_since, metadata, harness, billing_mode)
       VALUES ($1, $2, 'inactive', $3, $4, $5, $6, $6, NULL, $7, 'codex', 'api')`,
      "trace-upgrade-session",
      "Trace upgrade session",
      "/workspace/project",
      "gpt-5",
      "2026-06-16T10:00:00.000Z",
      "2026-06-16T10:40:00.000Z",
      JSON.stringify({
        artifacts: {
          prs: [
            {
              number: 17,
              title: "Legacy merged claim",
              status: SessionPrLifecycleStatus.Merged,
            },
          ],
        },
      })
    );
    await db.run(
      `INSERT INTO sessions
         (id, name, status, cwd, model, started_at, updated_at, ended_at,
          awaiting_input_since, metadata, harness, billing_mode)
       VALUES ($1, $2, 'inactive', $3, $4, $5, $6, $6, NULL, $7, 'codex', 'api')`,
      "metadata-only-trace-upgrade-session",
      "Metadata-only trace upgrade session",
      "/workspace/project-metadata-only",
      "gpt-5",
      "2026-06-16T10:05:00.000Z",
      "2026-06-16T10:42:00.000Z",
      JSON.stringify({
        artifacts: {
          prs: [
            {
              number: 18,
              title: "Legacy metadata-only merged claim",
              status: SessionPrLifecycleStatus.Merged,
            },
          ],
        },
      })
    );
    await db.run(
      `INSERT INTO pull_requests
         (id, session_id, pr_url, pr_number, repo_full_name, title, harness,
          observed_at, created_at)
       VALUES ($1, $2, $3, 17, $4, $5, 'codex', $6, $6)`,
      "url-only-pr",
      "trace-upgrade-session",
      "https://github.com/closedloop-ai/symphony-alpha/pull/17",
      "closedloop-ai/symphony-alpha",
      "URL-only PR",
      "2026-06-16T10:35:00.000Z"
    );

    // SQLite has no information_schema; pragma_table_info(<table>) is the
    // table-valued equivalent. Project (table_name, column_name) so the
    // assertion shape is unchanged from the Postgres catalog query.
    const columns = await db.prisma.client.$queryRawUnsafe<
      {
        table_name: string;
        column_name: string;
      }[]
    >(
      `SELECT 'sessions' AS table_name, name AS column_name
       FROM pragma_table_info('sessions')
       WHERE name IN ('trace_phase_sources', 'throttle_sources', 'correction_sources')
       UNION ALL
       SELECT 'pull_requests' AS table_name, name AS column_name
       FROM pragma_table_info('pull_requests')
       WHERE name IN ('state', 'closed_at', 'merged_at')
       ORDER BY table_name, column_name`
    );
    assert.deepEqual(
      columns.map((row) => `${row.table_name}.${row.column_name}`),
      [
        "pull_requests.closed_at",
        "pull_requests.merged_at",
        "pull_requests.state",
        "sessions.correction_sources",
        "sessions.throttle_sources",
        "sessions.trace_phase_sources",
      ]
    );

    await db.run(
      `INSERT INTO events
         (id, session_id, event_type, tool_name, summary, data, created_at)
       VALUES
         ($1, $7, 'UserMessage', NULL, 'Prompt', $8, $2),
         ($3, $7, 'loop.perf.phase', NULL, 'Implementation', $9, $4),
         ($5, $7, 'provider.rate_limit', 'Codex', 'Rate limited', $10, $4),
         ($6, $7, 'manual_regression', NULL, 'Correction', $11, $4)`,
      "event-prompt",
      "2026-06-16T10:00:00.000Z",
      "event-phase",
      "2026-06-16T10:15:00.000Z",
      "event-throttle",
      "event-correction",
      "trace-upgrade-session",
      JSON.stringify({ role: "human", timestamp: "2026-06-16T10:00:00.000Z" }),
      JSON.stringify({
        phaseKey: "implement",
        startedAt: "2026-06-16T10:05:00.000Z",
        endedAt: "2026-06-16T10:20:00.000Z",
      }),
      JSON.stringify({
        provider: "codex",
        statusCode: 429,
        retryAfterSeconds: 60,
      }),
      JSON.stringify({ kind: SessionTraceCorrectionKind.ManualRegression })
    );

    // FEA-1899: PRs surface from a 'created'/'workspace' artifact link, not the
    // pull_requests detail row. The migration backfilled the artifact (no
    // pr_state yet) and a 'referenced' link; add the authored link here. With no
    // pr_state, lifecycle status derives to Unknown.
    await insertSqlitePrArtifact(db, "trace-upgrade-session", {
      repoFullName: "closedloop-ai/symphony-alpha",
      prNumber: 17,
      title: "URL-only PR",
    });

    const [urlOnly] = await db.syncSource.loadSyncedSessions(
      ["trace-upgrade-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    assert.equal(urlOnly?.prs?.[0]?.status, SessionPrLifecycleStatus.Unknown);
    assert.equal(urlOnly?.tracePhaseSources?.[0]?.phaseKey, "implement");
    assert.equal(urlOnly?.throttleSources?.[0]?.statusCode, 429);
    assert.equal(
      urlOnly?.correctionSources?.[0]?.kind,
      SessionTraceCorrectionKind.ManualRegression
    );
    assert.equal(urlOnly?.phases?.[0]?.key, "implement");
    assert.equal(urlOnly?.throttles?.length, 1);
    assert.equal(
      urlOnly?.markers?.some((marker) => marker.kind === "frust"),
      true
    );
    assert.equal(typeof urlOnly?.autonomy, "number");

    // FEA-1899: a PR known only from legacy metadata.artifacts.prs (no artifact
    // link) no longer surfaces — the metadata path was removed because it
    // carried merely-referenced PRs that aren't the session's own work.
    const [metadataOnly] = await db.syncSource.loadSyncedSessions(
      ["metadata-only-trace-upgrade-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    assert.equal(metadataOnly?.prs?.length ?? 0, 0);

    // Lifecycle status now derives from artifacts.pr_state (the canonical
    // attribution spine), not the pull_requests detail row.
    await db.run(
      `UPDATE artifacts
       SET pr_state = $1
       WHERE identity_key = $2`,
      PullRequestState.Merged,
      "pr:closedloop-ai/symphony-alpha:17"
    );
    const [withLifecycle] = await db.syncSource.loadSyncedSessions(
      ["trace-upgrade-session"],
      {
        attributionByCwd: new Map(),
        launchMetadataRootByCwd: new Map(),
        repoFullNameByPath: new Map(),
      }
    );
    assert.equal(
      withLifecycle?.prs?.[0]?.status,
      SessionPrLifecycleStatus.Merged
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite lifecycle processes status transitions, subagents, transcript tokens, and bad hook payloads", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    extractTranscript: () => ({
      latestModel: "claude-opus-4-5",
      tokensByModel: new Map([
        [
          "claude-opus-4-5",
          { input: 100, output: 50, cacheRead: 10, cacheWrite: 5 },
        ],
      ]),
      compactionCount: 0,
      records: [],
      hasTrailingApiError: false,
    }),
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    assert.equal(
      await db.processEvent("SessionStart", { cwd: "/missing-id" }, "claude"),
      false
    );
    assert.equal(
      await db.processEvent(
        "SessionStart",
        { session_id: "life-1", cwd: "/work" },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent(
        "PreToolUse",
        {
          session_id: "life-1",
          tool_name: "Task",
          tool_input: {
            subagent_type: "engineer",
            description: "Implement the fix",
            prompt: "patch it",
          },
        },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent(
        "SubagentStop",
        {
          session_id: "life-1",
          tool_name: "Task",
        },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent("Stop", { session_id: "life-1" }, "claude"),
      true
    );
    assert.equal(
      await db.processEvent(
        "SessionEnd",
        {
          session_id: "life-1",
          transcript_path: "/tmp/transcript.jsonl",
        },
        "claude"
      ),
      true
    );

    const session = await db.sessions.getById("life-1");
    assert.equal(session?.status, "inactive");
    assert.equal(session?.model, "claude-opus-4-5");
    const agents = await db.agents.getBySession("life-1");
    assert.equal(
      agents.some(
        (agent) =>
          agent.subagentType === "engineer" && agent.status === "completed"
      ),
      true
    );
    const tokenRows = await db.tokenUsage.getBySession("life-1");
    assert.deepEqual(
      tokenRows.map((row) => ({
        model: row.model,
        input: row.inputTokens,
        output: row.outputTokens,
        cacheRead: row.cacheReadTokens,
        cacheWrite: row.cacheWriteTokens,
      })),
      [
        {
          model: "claude-opus-4-5",
          input: 100,
          output: 50,
          cacheRead: 10,
          cacheWrite: 5,
        },
      ]
    );

    assert.equal(
      await db.processEvent(
        "SessionStart",
        { session_id: "life-error", cwd: "/work" },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent(
        "Stop",
        { session_id: "life-error", stop_reason: "error" },
        "claude"
      ),
      true
    );
    assert.equal((await db.sessions.getById("life-error"))?.status, "error");
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("session-completion notice fires once per terminal transition (error via Stop, completed via SessionEnd; replays never re-notify)", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const notices: { sessionId: string; status: string }[] = [];

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: () => {
      /* live-update push not under test */
    },
    now: () => "2026-06-07T12:00:00.000Z",
    onSessionTerminal: (notice) => notices.push(notice),
  });
  try {
    // Errored session: Stop(error) is the authoritative terminal transition;
    // it lands before SessionEnd, so the error notice must come from Stop.
    await db.processEvent(
      "SessionStart",
      { session_id: "notify-error", cwd: "/work" },
      "claude"
    );
    await db.processEvent(
      "Stop",
      { session_id: "notify-error", stop_reason: "error" },
      "claude"
    );
    // SessionEnd arrives once the session is already terminal -> no re-notify.
    await db.processEvent(
      "SessionEnd",
      { session_id: "notify-error" },
      "claude"
    );

    // Completed session: SessionEnd performs the terminal transition itself.
    await db.processEvent(
      "SessionStart",
      { session_id: "notify-done", cwd: "/work" },
      "claude"
    );
    await db.processEvent(
      "SessionEnd",
      { session_id: "notify-done" },
      "claude"
    );
    // A replayed/backfilled SessionEnd on an already-terminal session is silent.
    await db.processEvent(
      "SessionEnd",
      { session_id: "notify-done" },
      "claude"
    );

    assert.deepEqual(notices, [
      { sessionId: "notify-error", status: "error" },
      { sessionId: "notify-done", status: "inactive" },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite lifecycle scans native Claude SubagentStop transcripts through processEvent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const previousClaudeHome = process.env.CLAUDE_HOME;
  const claudeHome = path.join(dir, "claude-home");
  process.env.CLAUDE_HOME = claudeHome;
  const projectDir = path.join(claudeHome, "projects", "claude-project");
  const workspaceDir = path.join(dir, "workspace-project");
  const parentTranscript = path.join(projectDir, "life-native.jsonl");
  const subagentsDir = path.join(projectDir, "life-native", "subagents");
  const nativeSubagentId = "agent-native_1";
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(parentTranscript, "{}\n", "utf8");
  await writeFile(
    path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-07T12:01:00.000Z",
      message: {
        content: [
          {
            type: "tool_use",
            id: "toolu_native_read",
            name: "Read",
            input: { file_path: "src/native.ts" },
          },
          {
            type: "tool_use",
            id: "toolu_native_read_2",
            name: "Read",
            input: { file_path: "src/native-2.ts" },
          },
        ],
      },
    })}\n`,
    "utf8"
  );

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: () => {},
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    assert.equal(
      await db.processEvent(
        "SessionStart",
        { session_id: "life-native", cwd: workspaceDir },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent(
        "PreToolUse",
        {
          session_id: "life-native",
          tool_name: "Task",
          tool_input: {
            subagent_type: "engineer",
            description: "Implement native scan",
            prompt: "patch it",
            agent_id: nativeSubagentId,
          },
        },
        "claude"
      ),
      true
    );
    assert.equal(
      await db.processEvent(
        "SubagentStop",
        {
          session_id: "life-native",
          tool_name: "Task",
          transcript_path: parentTranscript,
        },
        "claude"
      ),
      true
    );

    const agents = await db.agents.getBySession("life-native");
    const subagent = agents.find((agent) => agent.subagentType === "engineer");
    assert.ok(subagent);
    const events = await db.events.getBySession("life-native");
    const nativeReads = events.filter(
      (event) => event.eventType === "PostToolUse" && event.toolName === "Read"
    );
    assert.equal(nativeReads.length, 2);
    assert.equal(nativeReads[0]?.agentId, subagent.id);
    assert.deepEqual(JSON.parse(nativeReads[0]?.data ?? "{}"), {
      tool_name: "Read",
      tool_use_id: "toolu_native_read",
      input: { file_path: "src/native.ts" },
    });
    assert.deepEqual(JSON.parse(nativeReads[1]?.data ?? "{}"), {
      tool_name: "Read",
      tool_use_id: "toolu_native_read_2",
      input: { file_path: "src/native-2.ts" },
    });

    const noPartialRows = async (
      sessionId: string,
      preToolPayload: Record<string, unknown>,
      stopPayload: Record<string, unknown>,
      sessionPayload: Record<string, unknown> = {}
    ) => {
      await db.processEvent(
        "SessionStart",
        { session_id: sessionId, ...sessionPayload },
        "claude"
      );
      await db.processEvent(
        "PreToolUse",
        {
          session_id: sessionId,
          tool_name: "Task",
          tool_input: {
            subagent_type: "engineer",
            description: sessionId,
            prompt: sessionId,
            ...preToolPayload,
          },
        },
        "claude"
      );
      await db.processEvent(
        "SubagentStop",
        {
          session_id: sessionId,
          tool_name: "Task",
          ...stopPayload,
        },
        "claude"
      );
      const sessionEvents = await db.events.getBySession(sessionId);
      assert.equal(
        sessionEvents.some((event) => event.toolName === "Read"),
        false,
        `${sessionId} must not insert scanner tool rows`
      );
    };

    await noPartialRows(
      "life-native-absent-id",
      {},
      { transcript_path: parentTranscript }
    );
    await noPartialRows(
      "life-native-absent-file",
      { agent_id: "agent-missing" },
      { transcript_path: parentTranscript }
    );
    await noPartialRows(
      "life-native-subagent-path",
      { agent_id: nativeSubagentId },
      {
        transcript_path: path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
      }
    );
    await noPartialRows(
      "life-native-traversal",
      { agent_id: "../agent-native_1" },
      { transcript_path: parentTranscript }
    );

    const outRootSession = "life-native-out-root";
    const outRootDir = path.join(dir, "untrusted-parent");
    const outRootParent = path.join(outRootDir, `${outRootSession}.jsonl`);
    const outRootSubDir = path.join(outRootDir, outRootSession, "subagents");
    await mkdir(outRootSubDir, { recursive: true });
    await writeFile(outRootParent, "{}\n", "utf8");
    await writeFile(
      path.join(outRootSubDir, `${nativeSubagentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T12:02:00.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              name: "Read",
              input: { file_path: "src/out-root.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );
    await noPartialRows(
      outRootSession,
      { agent_id: nativeSubagentId },
      { transcript_path: outRootParent },
      { cwd: projectDir }
    );

    const cwdOnlySession = "life-native-cwd-only";
    const cwdOnlyDir = path.join(dir, "cwd-only-parent");
    const cwdOnlyParent = path.join(cwdOnlyDir, `${cwdOnlySession}.jsonl`);
    const cwdOnlySubDir = path.join(cwdOnlyDir, cwdOnlySession, "subagents");
    await mkdir(cwdOnlySubDir, { recursive: true });
    await writeFile(cwdOnlyParent, "{}\n", "utf8");
    await writeFile(
      path.join(cwdOnlySubDir, `${nativeSubagentId}.jsonl`),
      `${JSON.stringify({
        type: "assistant",
        timestamp: "2026-06-07T12:02:30.000Z",
        message: {
          content: [
            {
              type: "tool_use",
              id: "toolu_cwd_only",
              name: "Read",
              input: { file_path: "src/cwd-only.ts" },
            },
          ],
        },
      })}\n`,
      "utf8"
    );
    await noPartialRows(
      cwdOnlySession,
      { agent_id: nativeSubagentId },
      { transcript_path: cwdOnlyParent },
      { cwd: cwdOnlyDir }
    );

    const corruptSession = "life-native-corrupt";
    const corruptParent = path.join(projectDir, `${corruptSession}.jsonl`);
    const corruptSubDir = path.join(projectDir, corruptSession, "subagents");
    await mkdir(corruptSubDir, { recursive: true });
    await writeFile(corruptParent, "{}\n", "utf8");
    await writeFile(
      path.join(corruptSubDir, `${nativeSubagentId}.jsonl`),
      [
        "{not-json",
        JSON.stringify({
          type: "assistant",
          timestamp: "2026-06-07T12:03:00.000Z",
          message: {
            content: [
              {
                type: "tool_use",
                name: "Read",
                input: { file_path: "src/corrupt.ts" },
              },
            ],
          },
        }),
      ].join("\n"),
      "utf8"
    );
    await noPartialRows(
      corruptSession,
      { agent_id: nativeSubagentId },
      { transcript_path: corruptParent },
      { cwd: projectDir }
    );

    const outside = path.join(dir, "outside.jsonl");
    await writeFile(outside, "{}\n", "utf8");
    const symlinkSession = "life-native-symlink";
    const symlinkProject = path.join(dir, "claude-symlink");
    const symlinkParent = path.join(symlinkProject, `${symlinkSession}.jsonl`);
    const symlinkSubDir = path.join(
      symlinkProject,
      symlinkSession,
      "subagents"
    );
    await mkdir(symlinkSubDir, { recursive: true });
    await writeFile(symlinkParent, "{}\n", "utf8");
    await symlink(outside, path.join(symlinkSubDir, "agent-link.jsonl"));
    await noPartialRows(
      symlinkSession,
      { agent_id: "agent-link" },
      { transcript_path: symlinkParent }
    );
  } finally {
    await db.close();
    if (previousClaudeHome === undefined) {
      Reflect.deleteProperty(process.env, "CLAUDE_HOME");
    } else {
      process.env.CLAUDE_HOME = previousClaudeHome;
    }
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer persists parser-supplied nested subagents without session metadata projection", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: () => {},
    now: () => "2026-06-07T12:00:00.000Z",
  });

  const session: NormalizedSession = {
    sessionId: "parser-subagents",
    name: "Parser Subagents",
    cwd: "/workspace/project",
    model: "claude-sonnet-4-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {},
    messageTimestamps: [],
    toolUses: [],
    subagents: [
      {
        id: "agent-parent",
        parentId: null,
        name: "Parent Agent",
        type: "research",
        task: "collect context",
        startedAt: "2026-06-07T12:01:00.000Z",
        endedAt: "2026-06-07T12:02:00.000Z",
        status: "completed",
        nativeSubagentId: "agent-parent-native",
        toolUses: [
          {
            name: "Read",
            timestamp: "2026-06-07T12:01:30.000Z",
            input: { file_path: "src/parent.ts" },
          },
        ],
      },
      {
        id: "agent-child",
        parentId: "agent-parent",
        name: "Child Agent",
        type: "implementation",
        task: "patch code",
        startedAt: "2026-06-07T12:02:00.000Z",
        endedAt: "2026-06-07T12:03:00.000Z",
        status: "completed",
        nativeSubagentId: "agent-child-native",
        toolUses: [
          {
            name: "Bash",
            timestamp: "2026-06-07T12:02:30.000Z",
            input: { command: "pnpm test" },
          },
        ],
      },
    ],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: 0,
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    skills: [],
    hooks: [],
    artifacts: { prs: [], issues: [], repo: null },
    prLinks: [],
  };

  try {
    await db.importer.importSession(session, "claude");
    await db.importer.importSession(session, "claude");

    const persisted = await db.sessions.getById(session.sessionId);
    const sessionMetadata = JSON.parse(persisted?.metadata ?? "{}");
    assert.equal("subagents" in sessionMetadata, false);

    const agents = await db.agents.getBySession(session.sessionId);
    const parserAgents = agents.filter((agent) => agent.type === "subagent");
    assert.equal(parserAgents.length, 2);
    const parent = parserAgents.find((agent) => agent.name === "Parent Agent");
    const child = parserAgents.find((agent) => agent.name === "Child Agent");
    assert.ok(parent);
    assert.ok(child);
    assert.equal(parent.parentAgentId, `${session.sessionId}-main`);
    assert.equal(child.parentAgentId, parent.id);
    assert.equal(
      JSON.parse(parent.metadata ?? "{}").nativeSubagentId,
      "agent-parent-native"
    );
    assert.equal(
      JSON.parse(child.metadata ?? "{}").nativeSubagentId,
      "agent-child-native"
    );

    const events = await db.events.getBySession(session.sessionId);
    assert.equal(events.filter((event) => event.toolName === "Read").length, 1);
    assert.equal(events.filter((event) => event.toolName === "Bash").length, 1);
    assert.equal(
      events.find((event) => event.toolName === "Read")?.agentId,
      parent.id
    );
    assert.equal(
      events.find((event) => event.toolName === "Bash")?.agentId,
      child.id
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer persists overlapping Claude inline and sidecar tool use once", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const sessionId = "claude-inline-sidecar-import";
  const nativeSubagentId = "agent-dup";
  const parentTranscript = path.join(dir, `${sessionId}.jsonl`);
  const subagentsDir = path.join(dir, sessionId, "subagents");
  await mkdir(subagentsDir, { recursive: true });
  await writeFile(
    parentTranscript,
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-07T12:00:00.000Z",
      uuid: nativeSubagentId,
      isSidechain: true,
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [
          {
            type: "tool_use",
            id: "toolu_duplicate_import",
            name: "Read",
            input: { file_path: "inline.ts" },
          },
        ],
      },
    })}\n`,
    "utf8"
  );
  await writeFile(
    path.join(subagentsDir, `${nativeSubagentId}.jsonl`),
    `${JSON.stringify({
      type: "assistant",
      timestamp: "2026-06-07T12:00:00.000Z",
      message: {
        role: "assistant",
        model: "claude-sonnet-4-5",
        usage: {
          input_tokens: 10,
          output_tokens: 5,
          cache_read_input_tokens: 0,
          cache_creation_input_tokens: 0,
        },
        content: [
          {
            type: "tool_use",
            id: "toolu_duplicate_import",
            name: "Read",
            input: { file_path: "sidecar.ts" },
          },
        ],
      },
    })}\n`,
    "utf8"
  );

  const parsed = await parseClaudeFile(parentTranscript);
  assert.ok(parsed);

  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    emit: () => {},
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.importer.importSession(parsed, "claude");
    const firstTokenRows = await db.tokenUsage.getBySession(sessionId);
    await db.importer.importSession(parsed, "claude");

    const agents = await db.agents.getBySession(sessionId);
    const subagent = agents.find((agent) => agent.type === "subagent");
    assert.ok(subagent);
    const events = await db.events.getBySession(sessionId);
    const readEvents = events.filter(
      (event) => event.eventType === "PostToolUse" && event.toolName === "Read"
    );
    assert.equal(readEvents.length, 1);
    assert.equal(readEvents[0]?.agentId, subagent.id);
    assert.deepEqual(JSON.parse(readEvents[0]?.data ?? "{}"), {
      providerToolUseId: "toolu_duplicate_import",
      // FEA-2642: the Claude parser tags each tool-use event's data with its
      // classified kind. Read is a built-in tool, so kind="builtin".
      kind: "builtin",
      // Bug 019f881c: importToolEventData persists the per-call input under the
      // live-hook `tool_input` key so the Session Trace's expandable rows show
      // captured detail for imported sessions too. The raw input is NO LONGER
      // ALSO flat-spread to top-level keys (thread PRRT_kwDOQ4gDpM6S0qJP), so
      // `file_path` appears only nested under `tool_input` — the top level keeps
      // ONLY the small derived analytics/identity keys (`kind` and the provider
      // tool-use id). This tool_use has no tool_result, so no `tool_response` is
      // present. The dedup guarantee below (readEvents.length === 1) is what this
      // test pins — the overlapping inline+sidecar tool use is still persisted
      // exactly ONCE, from the inline (parent) source.
      tool_input: { file_path: "inline.ts" },
    });
    assert.deepEqual(
      await db.tokenUsage.getBySession(sessionId),
      firstTokenRows
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer is idempotent and can append new historical events", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    const session = makeNormalizedSession();
    assert.equal(
      (await db.importer.importSession(session, "codex")).skipped,
      false
    );
    const firstEventCount = (await db.events.getBySession(session.sessionId))
      .length;
    const firstTokenRows = await db.tokenUsage.getBySession(session.sessionId);
    // FEA-3227: a byte-identical re-import is a true no-op — `skipped` is true
    // when metadata, data_revision, and artifact links are unchanged.
    assert.equal(
      (await db.importer.importSession(session, "codex")).skipped,
      true
    );
    assert.equal(
      (await db.events.getBySession(session.sessionId)).length,
      firstEventCount
    );
    assert.deepEqual(
      await db.tokenUsage.getBySession(session.sessionId),
      firstTokenRows
    );

    const extended: NormalizedSession = {
      ...session,
      messageTimestamps: [
        ...session.messageTimestamps,
        "2026-06-07T11:04:00.000Z",
      ],
      fileModifiedAt: Date.parse("2026-06-07T12:00:00.000Z"),
    };
    const appended = await db.importer.importSession(extended, "codex");
    assert.equal(appended.skipped, false);
    assert.equal(
      (await db.events.getBySession(session.sessionId)).length,
      firstEventCount + 1
    );
    assert.equal(
      (await db.sessions.getById(session.sessionId))?.status,
      "active"
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("SQLite importer stores folded Codex child tool uses only on subagent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const sessionsDir = path.join(dir, "sessions");
  const rolloutDir = path.join(sessionsDir, "2026", "06", "24");
  const parentId = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const childId = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  let db: Awaited<ReturnType<typeof openSqliteAgentDatabase>> | null = null;

  const writeRollout = async (
    id: string,
    prefix: string,
    lines: readonly unknown[]
  ): Promise<string> => {
    await mkdir(rolloutDir, { recursive: true });
    const filePath = path.join(rolloutDir, `rollout-${prefix}-${id}.jsonl`);
    await writeFile(
      filePath,
      `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`,
      "utf8"
    );
    return filePath;
  };

  const tokenCount = (
    timestamp: string,
    inputTokens: number,
    outputTokens: number
  ) => ({
    timestamp,
    type: "event_msg",
    payload: {
      type: "token_count",
      info: {
        total_token_usage: {
          input_tokens: inputTokens,
          cached_input_tokens: 0,
          output_tokens: outputTokens,
        },
      },
      turn_context: { model: "gpt-5-codex" },
    },
  });

  try {
    const parentPath = await writeRollout(parentId, "2026-06-24T10-10-00", [
      {
        timestamp: "2026-06-24T10:10:00.000Z",
        type: "session_meta",
        payload: {
          id: parentId,
          cwd: "/workspace/codex-import",
          cli_version: "0.40.0",
          source: "exec",
        },
      },
      {
        timestamp: "2026-06-24T10:10:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5-codex", cwd: "/workspace/codex-import" },
      },
      {
        timestamp: "2026-06-24T10:10:01.000Z",
        type: "event_msg",
        payload: { type: "user_message", message: "ship it" },
      },
      {
        timestamp: "2026-06-24T10:10:02.000Z",
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "working" }],
        },
      },
      tokenCount("2026-06-24T10:10:03.000Z", 100, 10),
    ]);
    const childPath = await writeRollout(childId, "2026-06-24T10-11-00", [
      {
        timestamp: "2026-06-24T10:11:00.000Z",
        type: "session_meta",
        payload: {
          id: childId,
          cwd: "/workspace/codex-import",
          cli_version: "0.40.0",
          source: {
            subagent: {
              agent_nickname: "child-worker",
              agent_role: "worker",
              thread_spawn: {
                parent_thread_id: parentId,
                depth: 1,
              },
            },
          },
        },
      },
      {
        timestamp: "2026-06-24T10:11:00.000Z",
        type: "turn_context",
        payload: { model: "gpt-5-codex", cwd: "/workspace/codex-import" },
      },
      {
        timestamp: "2026-06-24T10:11:01.000Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_begin",
          server: "github",
          method: "create_pull_request",
          arguments: { title: "child PR" },
        },
      },
      {
        timestamp: "2026-06-24T10:11:02.000Z",
        type: "event_msg",
        payload: {
          type: "mcp_tool_call_end",
          output: {
            url: "https://github.com/closedloop-ai/symphony-alpha/pull/4242",
          },
        },
      },
      tokenCount("2026-06-24T10:11:03.000Z", 50, 5),
    ]);
    const sources = [parentPath, childPath];
    const collector = createCodexCollector({
      sessionsDir,
      archivedDir: path.join(dir, "archive"),
      listSources: () => sources,
    });

    assert.deepEqual(await collector.parse(childPath), []);
    const [parsed] = await collector.parse(parentPath);
    assert.ok(parsed);
    assert.equal(parsed.subagents?.[0]?.id, childId);
    assert.equal(parsed.subagents?.[0]?.toolUses?.length, 1);
    assert.equal(parsed.toolUses.length, 1);
    assert.equal(parsed.toolUses[0]?.subagentId, childId);

    db = await openSqliteAgentDatabase({
      dataDir,
      detectBillingMode: () => "api",
      now: () => "2026-06-24T12:00:00.000Z",
    });

    assert.equal(
      (await db.importer.importSession(parsed, "codex")).skipped,
      false
    );
    assert.equal(await db.sessions.getById(childId), undefined);

    const parserSubagentId = `${parentId}-parser-sub-${childId}`;
    const agents = await db.agents.getBySession(parentId);
    assert.equal(agents.length, 2);
    assert.ok(agents.some((agent) => agent.id === parserSubagentId));

    const events = await db.events.getBySession(parentId);
    const postToolEvents = events.filter(
      (event) => event.eventType === "PostToolUse"
    );
    assert.equal(postToolEvents.length, 1);
    assert.equal(postToolEvents[0]?.agentId, parserSubagentId);
    assert.equal(postToolEvents[0]?.toolName, "github__create_pull_request");
    assert.equal(
      postToolEvents.some((event) => event.agentId === `${parentId}-main`),
      false
    );
  } finally {
    await db?.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-1899: PRs surface from artifact links (relation 'created'/'workspace')
// joined to the canonical artifacts table — no longer from the pull_requests
// detail store. Mirrors persistNormalizedPullRequests' identity_key/id scheme.
async function insertSqlitePrArtifact(
  db: Awaited<ReturnType<typeof openSqliteAgentDatabase>>,
  sessionId: string,
  pr: {
    repoFullName: string;
    prNumber: number;
    title?: string | null;
    prState?: string | null;
    relation?: "created" | "workspace";
    observedAt?: string;
  }
): Promise<void> {
  const relation = pr.relation ?? "created";
  const observedAt = pr.observedAt ?? "2026-06-16T10:35:00.000Z";
  const identityKey = computeIdentityKey({
    kind: "pull_request",
    repoFullName: pr.repoFullName,
    prNumber: pr.prNumber,
  });
  const artifactId = artifactIdFromIdentityKey(identityKey);
  await db.run(
    `INSERT INTO artifacts
       (id, identity_key, kind, repo_full_name, pr_number, title, pr_state,
        harness, observed_at, created_at, last_seen_at)
     VALUES ($1, $2, 'pull_request', $3, $4, $5, $6, 'codex', $7, $7, $7)
     ON CONFLICT(identity_key) DO UPDATE SET
       title = COALESCE(artifacts.title, EXCLUDED.title),
       pr_state = COALESCE(EXCLUDED.pr_state, artifacts.pr_state),
       last_seen_at = EXCLUDED.last_seen_at`,
    artifactId,
    identityKey,
    pr.repoFullName,
    pr.prNumber,
    pr.title ?? null,
    pr.prState ?? null,
    observedAt
  );
  await db.run(
    `INSERT INTO session_artifact_links
       (id, session_id, artifact_id, relation, method, evidence, is_primary,
        status, extractor_version, observed_at, created_at)
     VALUES ($1, $2, $3, $4, 'test_fixture', '{}', 0, 'candidate', 1, $5, $5)
     ON CONFLICT(session_id, artifact_id, relation) DO NOTHING`,
    `${sessionId}:${artifactId}:${relation}`,
    sessionId,
    artifactId,
    relation,
    observedAt
  );
}

test("FEA-2868: median PR size ignores un-enriched PRs while KLOC still counts them", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-20T12:00:00.000Z",
  });

  try {
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at)
       VALUES ('fea2868-s', 'inactive', $1, $1)`,
      "2026-06-16T10:00:00.000Z"
    );

    // Three ENRICHED PRs with known sizes 100 / 300 / 500 (median 300)...
    const enriched: [number, number][] = [
      [1, 100],
      [2, 300],
      [3, 500],
    ];
    for (const [prNumber, loc] of enriched) {
      await insertSqlitePrArtifact(db, "fea2868-s", {
        repoFullName: "closedloop-ai/symphony-alpha",
        prNumber,
      });
      await db.run(
        "UPDATE artifacts SET lines_added = $1, lines_removed = 0 WHERE pr_number = $2",
        loc,
        prNumber
      );
    }
    // ...and five UN-enriched PRs (lines_added/lines_removed left NULL). Before
    // FEA-2868 these folded into the median as 0, dragging it to 0.
    for (let prNumber = 10; prNumber < 15; prNumber++) {
      await insertSqlitePrArtifact(db, "fea2868-s", {
        repoFullName: "closedloop-ai/symphony-alpha",
        prNumber,
      });
    }

    const delivery = await db.dashboard.getInsights(
      InsightsSection.Delivery,
      "90",
      new Date("2026-06-20T12:00:00.000Z")
    );
    const kpi = (key: string) =>
      delivery.kpis.find((entry) => entry.key === key)?.value;

    // Median reflects only the enriched PRs (300), NOT the zero-padded 0.
    assert.equal(kpi("pr-size"), 300);
    // KLOC still sums ALL captured PRs' LOC (900 → 0.9k); un-enriched add 0.
    assert.equal(kpi("kloc"), 0.9);
    // Captured PRs still counts every PR artifact in the window (3 + 5).
    assert.equal(kpi("merged"), 8);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2866: import never persists an unvalidated bare-basename repo_full_name", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // A git-validated repo (as captureRepoIdentity would upsert) so the write-path
    // resolver can map the bare folder name `symphony-alpha` → its owner/repo slug.
    await db.run(
      `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
       VALUES ('fea2866-repo', '/w/symphony-alpha/.git', 'git@github.com:closedloop-ai/symphony-alpha.git', 'closedloop-ai/symphony-alpha', 'main', $1, $1)`,
      "2026-06-07T00:00:00.000Z"
    );

    // Session whose parser-derived repo is a bare worktree dir name (no owner) —
    // the exact pollution FEA-2866 removes. Its start-branch artifact would have
    // carried that bare name as repo_full_name.
    const junk: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "fea2866-junk",
      gitBranch: "agent-work",
      artifacts: { prs: [], issues: [], repo: "agent-a423e10d3ca273c56" },
    };
    assert.equal(
      (await db.importer.importSession(junk, "claude")).skipped,
      false
    );

    // Session whose parser-derived repo is a bare but KNOWN folder name → resolves.
    const known: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "fea2866-known",
      gitBranch: "fea-known",
      artifacts: { prs: [], issues: [], repo: "symphony-alpha" },
    };
    assert.equal(
      (await db.importer.importSession(known, "claude")).skipped,
      false
    );

    // Session whose parser-derived repo CONTAINS a slash but is NOT a valid
    // owner/repo slug (an extra path segment). A loose `includes("/")` fallback
    // would wrongly keep it; the `normalizeRepoFullName` validator rejects it so
    // it is dropped to null (groups under "Unknown"), not surfaced as a repo.
    const malformed: NormalizedSession = {
      ...makeNormalizedSession(),
      sessionId: "fea2866-malformed",
      gitBranch: "fea-malformed",
      artifacts: {
        prs: [],
        issues: [],
        repo: "closedloop-ai/symphony-alpha/nested",
      },
    };
    assert.equal(
      (await db.importer.importSession(malformed, "claude")).skipped,
      false
    );

    const names = (
      await db.prisma.client.$queryRawUnsafe<
        { repo_full_name: string | null }[]
      >(
        "SELECT DISTINCT repo_full_name FROM artifacts WHERE repo_full_name IS NOT NULL"
      )
    ).map((row) => row.repo_full_name);

    // The bare worktree name is never surfaced as a repository...
    assert.equal(names.includes("agent-a423e10d3ca273c56"), false);
    // ...the bare known folder is upgraded to its validated owner/repo slug...
    assert.equal(names.includes("closedloop-ai/symphony-alpha"), true);
    // ...the slash-containing-but-invalid value is dropped by the validator...
    assert.equal(names.includes("closedloop-ai/symphony-alpha/nested"), false);
    // ...and every surviving value is a valid owner/repo slug.
    assert.equal(
      names.some(
        (name) => name !== null && normalizeRepoFullName(name) === null
      ),
      false
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-2866: repairPollutedRepoFullNames resolves known bare repos, nulls junk, is idempotent", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // The background boot-maintenance chain runs its own FEA-2866
    // `repairPollutedRepoFullNames` sweep; await it to completion BEFORE seeding
    // the polluted fixtures below, otherwise the sweep can fire late (once the
    // `repos` row + bare artifacts exist) and resolve `symphony-alpha` →
    // `closedloop-ai/symphony-alpha` out from under the assertion, leaving only
    // one bare row for the explicit repair call to fix.
    await db.whenBootMaintenanceSettled();
    await db.run(
      `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
       VALUES ('fea2866-repo', '/w/symphony-alpha/.git', 'git@github.com:closedloop-ai/symphony-alpha.git', 'closedloop-ai/symphony-alpha', 'main', $1, $1)`,
      "2026-06-07T00:00:00.000Z"
    );
    await db.run(
      `INSERT INTO sessions (id, status, started_at, updated_at)
       VALUES ('fea2866-s', 'inactive', $1, $1)`,
      "2026-06-07T10:00:00.000Z"
    );

    // Pre-fix pollution stamped onto existing artifact rows.
    await insertSqlitePrArtifact(db, "fea2866-s", {
      repoFullName: "symphony-alpha", // bare + KNOWN → resolves to owner/repo
      prNumber: 1,
    });
    await insertSqlitePrArtifact(db, "fea2866-s", {
      repoFullName: "agent-a423e10d3ca273c56", // bare junk (worktree) → nulled
      prNumber: 2,
    });
    await insertSqlitePrArtifact(db, "fea2866-s", {
      repoFullName: "closedloop-ai/symphony-alpha", // already valid → untouched
      prNumber: 3,
    });

    const repaired = await repairPollutedRepoFullNames(
      db.prisma,
      () => undefined
    );
    assert.equal(repaired, 2);

    const byNumber = new Map(
      (
        await db.prisma.client.$queryRawUnsafe<
          {
            pr_number: number;
            repo_full_name: string | null;
            git_dir: string | null;
          }[]
        >("SELECT pr_number, repo_full_name, git_dir FROM artifacts")
      ).map((row) => [Number(row.pr_number), row])
    );
    assert.equal(
      byNumber.get(1)?.repo_full_name,
      "closedloop-ai/symphony-alpha"
    );
    assert.equal(byNumber.get(2)?.repo_full_name, null);
    assert.equal(
      byNumber.get(3)?.repo_full_name,
      "closedloop-ai/symphony-alpha"
    );

    // Resolved rows also backfill git_dir so downstream enrichment can use local
    // git; junk rows keep git_dir NULL.
    assert.equal(byNumber.get(1)?.git_dir, "/w/symphony-alpha/.git");
    assert.equal(byNumber.get(2)?.git_dir, null);

    // Idempotent: nothing bare remains, so a second pass repairs zero rows.
    assert.equal(
      await repairPollutedRepoFullNames(db.prisma, () => undefined),
      0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("FEA-3371: repairPollutedRepoFullNames backfills NULL repo_full_name from git_dir, idempotently", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    await db.whenBootMaintenanceSettled();
    // A repo whose remote resolved (canonical owner/repo known) keyed by git_dir.
    await db.run(
      `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
       VALUES ('fea3371-repo', '/w/symphony-alpha/.git', 'git@github.com:closedloop-ai/symphony-alpha.git', 'closedloop-ai/symphony-alpha', 'main', $1, $1)`,
      "2026-06-07T00:00:00.000Z"
    );
    // An orphan git_dir with no canonical name — its artifact must stay NULL.
    await db.run(
      `INSERT INTO repos (id, git_dir, remote_url, repo_full_name, default_branch, last_seen_at, created_at)
       VALUES ('fea3371-orphan', '/w/no-remote/.git', NULL, NULL, NULL, $1, $1)`,
      "2026-06-07T00:00:00.000Z"
    );

    // Artifact A: NULL repo_full_name but a git_dir that maps to the canonical repo
    // → backfilled. Artifact B: NULL repo_full_name + git_dir to the orphan repo
    // (no canonical) → left NULL. Artifact C: NULL repo_full_name + NULL git_dir →
    // untouched (nothing to resolve from).
    await db.run(
      `INSERT INTO artifacts (id, identity_key, kind, repo_full_name, git_dir, branch_name, created_at, last_seen_at)
       VALUES
         ('fea3371-a', 'k-a', 'branch', NULL, '/w/symphony-alpha/.git', 'feature/a', $1, $1),
         ('fea3371-b', 'k-b', 'branch', NULL, '/w/no-remote/.git', 'feature/b', $1, $1),
         ('fea3371-c', 'k-c', 'branch', NULL, NULL, 'feature/c', $1, $1)`,
      "2026-06-07T00:00:00.000Z"
    );

    const repaired = await repairPollutedRepoFullNames(
      db.prisma,
      () => undefined
    );
    assert.equal(
      repaired,
      1,
      "only artifact A had a resolvable canonical name"
    );

    const byId = new Map(
      (
        await db.prisma.client.$queryRawUnsafe<
          { id: string; repo_full_name: string | null }[]
        >("SELECT id, repo_full_name FROM artifacts")
      ).map((row) => [row.id, row.repo_full_name])
    );
    assert.equal(
      byId.get("fea3371-a"),
      "closedloop-ai/symphony-alpha",
      "NULL repo_full_name backfilled from the git_dir's canonical repo"
    );
    assert.equal(byId.get("fea3371-b"), null, "orphan git_dir stays NULL");
    assert.equal(byId.get("fea3371-c"), null, "NULL git_dir stays NULL");

    // Idempotent: a second pass backfills zero (A already filled, B/C unresolvable).
    assert.equal(
      await repairPollutedRepoFullNames(db.prisma, () => undefined),
      0
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

function makeNormalizedSession(): NormalizedSession {
  return {
    sessionId: "imported-session-1",
    name: "Imported Session",
    cwd: "/workspace/closedloop-electron",
    model: "gpt-5",
    version: "1.0.0",
    slug: "imported-session",
    gitBranch: "fea-1550",
    startedAt: "2026-06-07T11:00:00.000Z",
    endedAt: "2026-06-07T11:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "gpt-5": { input: 100, output: 40, cacheRead: 0, cacheWrite: 0 },
    },
    messageTimestamps: ["2026-06-07T11:00:30.000Z"],
    toolUses: [
      {
        name: "Skill",
        timestamp: "2026-06-07T11:01:00.000Z",
        input: { skill: "core/ship-dashboard" },
        skillName: "core/ship-dashboard",
      },
      {
        name: "Agent",
        timestamp: "2026-06-07T11:02:00.000Z",
        input: {
          subagent_type: "engineer",
          description: "Implement dashboard parity",
          prompt: "Move the old dashboard surfaces to SQLite.",
        },
      },
    ],
    plans: [
      {
        source: "codex",
        content:
          "## Ship SQLite dashboard parity\n\n- Move feature summaries\n- Keep workflows loading",
        timestamp: "2026-06-07T11:03:00.000Z",
      },
    ],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "codex",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: 0,
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    skills: [],
    hooks: [],
    artifacts: {
      prs: [{ number: "275", repo: "closedloop-ai/closedloop-electron" }],
      issues: [],
      repo: "closedloop-ai/closedloop-electron",
    },
    prLinks: [],
  };
}

// FEA-2038: the O(grouped) SQL analytics aggregate (`aggregateAnalytics`, used
// by the no-ids path) must deep-equal the JS hydrate fold (`buildAnalytics`,
// forced via an explicit-ids request) over the SAME corpus across byTool,
// byAgentType, and byRepository. This is the parity oracle the prescribed
// golden test does not cover (it only exercises insights/getTokenAnalytics).
test("FEA-2038: SQL analytics aggregate matches the hydrate-path buildAnalytics", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // FEA-4299: two sessions sharing one repo cwd (so byRepository merges them
    // by the resolved remote), one in a distinct repo, and one with NULL cwd (no
    // resolvable remote → dropped from the breakdown, matching the facet). The
    // cwds are REAL git repos so `repositoryFullName` resolves to the remote.
    const sharedRepoDir = path.join(dir, "wt-shared");
    const otherRepoDir = path.join(dir, "wt-other");
    await mkdir(sharedRepoDir, { recursive: true });
    await mkdir(otherRepoDir, { recursive: true });
    initGitRepoWithOrigin(sharedRepoDir, "acme/repo-shared");
    initGitRepoWithOrigin(otherRepoDir, "acme/repo-other");
    const sessionRows: [string, string | null][] = [
      ["s1", sharedRepoDir],
      ["s2", sharedRepoDir],
      ["s3", otherRepoDir],
      ["s4", null],
    ];
    for (const [id, cwd] of sessionRows) {
      await db.run(
        `INSERT INTO sessions
           (id, name, status, cwd, model, started_at, updated_at, harness, billing_mode, data_revision)
         VALUES ($1, $2, 'inactive', $3, 'claude-sonnet-4-5', '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', 'claude', 'metered_api', 1)`,
        id,
        id,
        cwd
      );
    }

    // token_usage: per-session input/output + estimated cost. s2 has two model
    // rows (per-session sum must fold to one repository contribution, not fan
    // out the error count).
    const tokenRows: [string, string, number, number, number | null][] = [
      ["s1", "claude-sonnet-4-5", 100, 50, 0.01],
      ["s2", "claude-sonnet-4-5", 200, 80, 0.02],
      ["s2", "claude-opus-4", 30, 10, 0.03],
      ["s3", "claude-sonnet-4-5", 5, 5, null],
      // s4 intentionally has no token rows (zero-token session).
    ];
    for (const [sid, model, input, output, cost] of tokenRows) {
      await db.run(
        `INSERT INTO token_usage
           (session_id, model, input_tokens, output_tokens, cost_usd_estimated, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`,
        sid,
        model,
        input,
        output,
        cost
      );
    }

    // agents: exercise COALESCE(subagent_type, type, 'unknown'), the
    // success/failed status predicates, and the duration fold (canonical iso,
    // empty ended_at → null duration, non-canonical → epoch, negative → skip).
    const agentRows: Array<{
      id: string;
      sid: string;
      type: string | null;
      subagent: string | null;
      status: string;
      started: string | null;
      ended: string | null;
    }> = [
      // resolves to "reviewer" (subagent_type wins), success, +60000ms
      {
        id: "a1",
        sid: "s1",
        type: "subagent",
        subagent: "reviewer",
        status: "completed",
        started: "2026-06-01T00:00:00.000Z",
        ended: "2026-06-01T00:01:00.000Z",
      },
      // resolves to "reviewer", failed, empty ended_at → null duration
      {
        id: "a2",
        sid: "s2",
        type: "subagent",
        subagent: "reviewer",
        status: "error",
        started: "2026-06-01T00:00:00.000Z",
        ended: "",
      },
      // resolves to "main" (type, no subagent), success, null started → null dur
      {
        id: "a3",
        sid: "s3",
        type: "main",
        subagent: null,
        status: "done",
        started: null,
        ended: "2026-06-01T00:01:00.000Z",
      },
      // resolves to "unknown" (both null), neither success nor failed
      {
        id: "a4",
        sid: "s4",
        type: null,
        subagent: null,
        status: "running",
        started: "2026-06-01T00:00:00.000Z",
        ended: "2026-06-01T00:00:30.000Z",
      },
      // resolves to "main", failed, negative duration → skipped from avg
      {
        id: "a5",
        sid: "s1",
        type: "main",
        subagent: null,
        status: "failed",
        started: "2026-06-01T00:01:00.000Z",
        ended: "2026-06-01T00:00:00.000Z",
      },
    ];
    for (const a of agentRows) {
      await db.run(
        `INSERT INTO agents
           (id, session_id, name, type, subagent_type, status, started_at, ended_at)
         VALUES ($1, $2, $1, $3, $4, $5, $6, $7)`,
        a.id,
        a.sid,
        a.type,
        a.subagent,
        a.status,
        a.started,
        a.ended
      );
    }

    // events: tool invocations with error/non-error event_type; one null-tool
    // event (must be ignored by byTool but still NOT counted as a repo error
    // unless its event_type matches). Mixed across sessions/repos.
    const eventRows: Array<{
      id: string;
      sid: string;
      type: string;
      tool: string | null;
    }> = [
      { id: "e1", sid: "s1", type: "PostToolUse", tool: "Bash" },
      { id: "e2", sid: "s1", type: "tool_error", tool: "Bash" },
      { id: "e3", sid: "s2", type: "PostToolUse", tool: "Edit" },
      { id: "e4", sid: "s2", type: "command_failed", tool: "Edit" },
      { id: "e5", sid: "s3", type: "PostToolUse", tool: "Bash" },
      { id: "e6", sid: "s3", type: "SessionEnd", tool: null },
      { id: "e7", sid: "s4", type: "failure_event", tool: "Bash" },
    ];
    for (const e of eventRows) {
      await db.run(
        `INSERT INTO events (id, session_id, event_type, tool_name, created_at)
         VALUES ($1, $2, $3, $4, '2026-06-01T00:00:00.000Z')`,
        e.id,
        e.sid,
        e.type,
        e.tool
      );
    }

    const allIds = sessionRows.map(([id]) => id);
    // SQL path: no ids, no search → routes through aggregateAnalytics.
    const sqlAnalytics = await getSharedAgentSessionAnalytics(
      db.syncSource,
      {}
    );
    // Hydrate path: explicit ids → forces loadWorkingSessions + buildAnalytics.
    const hydrateAnalytics = await getSharedAgentSessionAnalytics(
      db.syncSource,
      {
        ids: allIds,
      }
    );

    const sortTool = <T extends { toolName: string }>(rows: readonly T[]) =>
      [...rows].sort((a, b) => a.toolName.localeCompare(b.toolName));
    const sortAgent = <T extends { agentType: string }>(rows: readonly T[]) =>
      [...rows].sort((a, b) => a.agentType.localeCompare(b.agentType));
    const sortRepo = <T extends { repositoryFullName: string }>(
      rows: readonly T[]
    ) =>
      [...rows].sort((a, b) =>
        a.repositoryFullName.localeCompare(b.repositoryFullName)
      );

    assert.equal(sqlAnalytics.viewerScope, "self");
    assert.deepEqual(sqlAnalytics.byProject, []);
    assert.deepEqual(
      sortTool(sqlAnalytics.byTool),
      sortTool(hydrateAnalytics.byTool)
    );
    assert.deepEqual(
      sortAgent(sqlAnalytics.byAgentType),
      sortAgent(hydrateAnalytics.byAgentType)
    );
    // byRepository: all fields must match exactly EXCEPT `estimatedCost`, which
    // is a summed float and so can differ by ULP-level epsilon between the SQL
    // grouped accumulation and the per-session JS accumulation. Compare cost
    // within a tight tolerance and the rest exactly.
    const sqlRepo = sortRepo(sqlAnalytics.byRepository);
    const hydrateRepo = sortRepo(hydrateAnalytics.byRepository);
    assert.equal(sqlRepo.length, hydrateRepo.length);
    for (let i = 0; i < sqlRepo.length; i++) {
      const { estimatedCost: sqlCost, ...sqlRest } = sqlRepo[i];
      const { estimatedCost: hydrateCost, ...hydrateRest } = hydrateRepo[i];
      assert.deepEqual(sqlRest, hydrateRest);
      assert.ok(
        Math.abs(sqlCost - hydrateCost) < 1e-9,
        `estimatedCost parity for ${sqlRest.repositoryFullName}: sql=${sqlCost} hydrate=${hydrateCost}`
      );
    }

    // Anchor the absolute expectations so a same-direction drift in BOTH paths
    // cannot silently pass the equality above.
    assert.deepEqual(sortTool(sqlAnalytics.byTool), [
      { toolName: "Bash", invocationCount: 4, errorCount: 2, sessionCount: 3 },
      { toolName: "Edit", invocationCount: 2, errorCount: 1, sessionCount: 1 },
    ]);
    assert.deepEqual(sortAgent(sqlAnalytics.byAgentType), [
      {
        agentType: "main",
        count: 2,
        successCount: 1,
        failedCount: 1,
        avgDurationMs: null,
      },
      {
        agentType: "reviewer",
        count: 2,
        successCount: 1,
        failedCount: 1,
        avgDurationMs: 60_000,
      },
      {
        agentType: "unknown",
        count: 1,
        successCount: 0,
        failedCount: 0,
        avgDurationMs: 30_000,
      },
    ]);
    // FEA-4299: s4 (null cwd → no resolved remote) is dropped from the breakdown
    // — it renders "Unknown" and is not a Repository facet option. The remaining
    // rows key on the resolved Git remote, not a folder name.
    assert.deepEqual(sortRepo(sqlAnalytics.byRepository), [
      {
        repositoryFullName: "acme/repo-other",
        sessionCount: 1,
        inputTokens: 5,
        outputTokens: 5,
        estimatedCost: 0.000_089_999_999_999_999_99,
        errorCount: 0,
      },
      {
        repositoryFullName: "acme/repo-shared",
        sessionCount: 2,
        inputTokens: 330,
        outputTokens: 140,
        estimatedCost: 0.06,
        errorCount: 2,
      },
    ]);
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3318: the SQL analytics per-(cwd, model) cost rollup must reprice an
// unpriced + COMPACTED session on its EFFECTIVE tokens (current + pre-compaction
// `baseline_*`), matching the hydrate loader (FEA-2922) and the storage-path
// reprice (FEA-2879). Before the fix the rollup summed post-compaction tokens
// only, undercounting per-repository cost. The row is unpriced
// (`cost_usd_estimated IS NULL`) so it exercises the on-the-fly reprice, and
// carries baselines so the effective cost exceeds the current-only cost.
test("FEA-3318: SQL per-repo cost rollup folds baseline for compacted unpriced sessions", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  try {
    // FEA-4299: a REAL git repo cwd so `repositoryFullName` resolves to the
    // remote (a folder-only cwd would render "Unknown" and be dropped, which is
    // not what this cost-reprice fold intends to test).
    const compactedRepoDir = path.join(dir, "wt-compacted");
    await mkdir(compactedRepoDir, { recursive: true });
    initGitRepoWithOrigin(compactedRepoDir, "acme/repo-compacted");
    await db.run(
      `INSERT INTO sessions
         (id, name, status, cwd, model, started_at, updated_at, harness, billing_mode, data_revision)
       VALUES ('sc1', 'sc1', 'inactive', $1, 'claude-sonnet-4-5', '2026-06-01T00:00:00.000Z', '2026-06-01T01:00:00.000Z', 'claude', 'metered_api', 1)`,
      compactedRepoDir
    );
    // Unpriced (cost_usd_estimated NULL) + compacted (baseline_* > 0): effective
    // totals are current + baseline = 400 in / 160 out.
    await db.run(
      `INSERT INTO token_usage
         (session_id, model, input_tokens, output_tokens, cache_read_tokens, cache_write_tokens,
          baseline_input, baseline_output, baseline_cache_read, baseline_cache_write,
          cost_usd_estimated, created_at, updated_at)
       VALUES ('sc1', 'claude-sonnet-4-5', 100, 40, 0, 0, 300, 120, 0, 0, NULL, '2026-06-01T00:00:00.000Z', '2026-06-01T00:00:00.000Z')`
    );

    const priceOf = (inputTokens: number, outputTokens: number) =>
      resolveTokenUsageCostUsd({
        session_id: "sc1",
        model: "claude-sonnet-4-5",
        input_tokens: inputTokens,
        output_tokens: outputTokens,
        cache_read_tokens: 0,
        cache_write_tokens: 0,
        created_at: "2026-06-01T00:00:00.000Z",
        cost_usd_estimated: null,
      }) ?? 0;
    const effectiveCost = priceOf(400, 160);
    const currentOnlyCost = priceOf(100, 40);
    // Sanity: the baselines make the effective cost strictly larger than the
    // post-compaction-only cost, so a missed fold is observable.
    assert.ok(
      effectiveCost > currentOnlyCost && currentOnlyCost > 0,
      `effective ${effectiveCost} should exceed current-only ${currentOnlyCost} > 0`
    );

    // SQL path (no ids) → aggregateSqliteAnalytics; hydrate path (explicit ids) →
    // buildAnalytics, the parity oracle that folds baseline via loadWorkingSessions.
    const sqlAnalytics = await getSharedAgentSessionAnalytics(
      db.syncSource,
      {}
    );
    const hydrateAnalytics = await getSharedAgentSessionAnalytics(
      db.syncSource,
      {
        ids: ["sc1"],
      }
    );
    const sqlRepo = sqlAnalytics.byRepository.find(
      (r) => r.repositoryFullName === "acme/repo-compacted"
    );
    const hydrateRepo = hydrateAnalytics.byRepository.find(
      (r) => r.repositoryFullName === "acme/repo-compacted"
    );
    assert.ok(sqlRepo, "SQL byRepository must include the compacted repo");
    assert.ok(
      hydrateRepo,
      "hydrate byRepository must include the compacted repo"
    );

    // Displayed tokens are the effective (baseline-folded) totals, consistent
    // with the cost repriced from them — and with the hydrate oracle.
    assert.equal(sqlRepo.inputTokens, 400);
    assert.equal(sqlRepo.outputTokens, 160);
    assert.equal(sqlRepo.inputTokens, hydrateRepo.inputTokens);
    assert.equal(sqlRepo.outputTokens, hydrateRepo.outputTokens);
    assert.equal(sqlRepo.sessionCount, hydrateRepo.sessionCount);

    // The rollup reprices on the effective (baseline-folded) tokens, matching
    // both the absolute oracle and the hydrate path.
    assert.ok(
      Math.abs(sqlRepo.estimatedCost - effectiveCost) < 1e-12,
      `SQL repo cost ${sqlRepo.estimatedCost} should equal effective ${effectiveCost}`
    );
    assert.ok(
      Math.abs(sqlRepo.estimatedCost - hydrateRepo.estimatedCost) < 1e-12,
      `SQL repo cost ${sqlRepo.estimatedCost} should match hydrate ${hydrateRepo.estimatedCost}`
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// PRD-538: web search is billed per request, not per token. It must land on the
// SESSION cost exactly ONCE (in the rollup), never on a per-model token_usage
// row, and re-import must not accumulate it.
test("web-search cost is added once at the session level and never double-counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  const makeSession = (
    id: string,
    webSearchRequests: number
  ): NormalizedSession => ({
    sessionId: id,
    name: id,
    cwd: "/workspace/project",
    model: "claude-opus-4-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    // 1000 fresh input on claude-opus-4-5 ⇒ $0.005 token cost (genai-prices).
    tokensByModel: {
      "claude-opus-4-5": {
        input: 1000,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
      },
    },
    messageTimestamps: ["2026-06-07T12:00:30.000Z"],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: webSearchRequests,
    },
    messages: [],
    tokenSeries: [],
    diffStats: null,
    slashCommands: [],
    skills: [],
    hooks: [],
    artifacts: { prs: [], issues: [], repo: null },
    prLinks: [],
  });

  const sessionCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { cost_usd_estimated: number | null }[]
    >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", id);
    return Number(rows[0]?.cost_usd_estimated ?? 0);
  };
  // PRD-538: session_analytics.est_cost is the dashboard/sync-facing session
  // total, so it must include web-search cost too (kept out of token_usage on
  // purpose). It reads the SAME single web-search source the authoritative
  // sessions.cost_usd_estimated does, so the two must agree exactly.
  const analyticsCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { est_cost: number | null }[]
    >("SELECT est_cost FROM session_analytics WHERE session_id = $1", id);
    return Number(rows[0]?.est_cost ?? 0);
  };
  const tokenRowsCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<{ s: number | null }[]>(
      "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS s FROM token_usage WHERE session_id = $1",
      id
    );
    return Number(rows[0]?.s ?? 0);
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  try {
    await db.importer.importSession(makeSession("no-web", 0), "claude");
    await db.importer.importSession(makeSession("web", 3), "claude");

    const baseTokenCost = await tokenRowsCost("no-web");
    assert.ok(baseTokenCost > 0, "opus-4-5 token cost should be priced");

    // GUARD 1: the per-model token_usage rows carry ONLY token cost — the
    // web-search session's rows are identical to the no-web session's.
    assert.ok(near(await tokenRowsCost("web"), baseTokenCost));

    // The session total includes web search exactly once: tokens + 3 × $0.01.
    assert.ok(near(await sessionCost("web"), baseTokenCost + 0.03));
    assert.ok(near(await sessionCost("no-web"), baseTokenCost));
    // The delta between the two sessions is exactly the web-search cost.
    assert.ok(
      near((await sessionCost("web")) - (await sessionCost("no-web")), 0.03)
    );

    // GUARD 2 (PRD-538 P2): session_analytics.est_cost — the dashboard/sync
    // session total — now includes web-search cost (previously it summed only
    // token_usage.cost_usd_estimated and undercounted every web-search session).
    // It reads the SAME single web-search source as sessions.cost_usd_estimated,
    // so for the web session the analytics rollup equals the authoritative total
    // exactly (token cost + 3 × $0.01), never undercounting.
    assert.ok(near(await analyticsCost("web"), baseTokenCost + 0.03));
    assert.ok(near(await analyticsCost("web"), await sessionCost("web")));

    // GUARD 3: re-importing the same session must NOT accumulate web search
    // (the rollup recomputes from scratch, so it stays tokens + $0.03).
    await db.importer.importSession(makeSession("web", 3), "claude");
    assert.ok(near(await sessionCost("web"), baseTokenCost + 0.03));
    assert.ok(near(await analyticsCost("web"), baseTokenCost + 0.03));
    assert.ok(near(await tokenRowsCost("web"), baseTokenCost));
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});

// FEA-3419: the Claude 1h cache-write TTL premium is priced PER EVENT inside
// estimateTokenCost (cacheWrite1hTokens) — it lands in the token_events cost
// columns and the per-model token_usage cost, and the session rollup is a pure
// Σ(token_usage) + web search with NO separate premium line item (the FEA-3636
// session-level blob-based term was removed as a double-count). Conservation
// (Σ events == usage cost) holds WITH the premium included on both sides, and
// re-import must not accumulate it.
test("1h cache-write TTL premium is priced per event, conserves, and never double-counts", async () => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-dashboard-sqlite-"));
  const dataDir = path.join(dir, "agent-dashboard.pgdata");
  const db = await openSqliteAgentDatabase({
    dataDir,
    detectBillingMode: () => "metered_api",
    now: () => "2026-06-07T12:00:00.000Z",
  });

  // 1000 cache-write tokens on claude-opus-4-5, of which `oneHourTokens` were
  // one-hour ephemeral writes — carried as the TYPED cacheWriteTtl split on both
  // the per-model counts and the per-event record (there is no session blob).
  // All other counts zero so the session total is exactly the cache-write cost.
  const makeSession = (
    id: string,
    oneHourTokens: number
  ): NormalizedSession => ({
    sessionId: id,
    name: id,
    cwd: "/workspace/project",
    model: "claude-opus-4-5",
    version: null,
    slug: null,
    gitBranch: null,
    startedAt: "2026-06-07T12:00:00.000Z",
    endedAt: "2026-06-07T12:05:00.000Z",
    teams: [],
    userMessages: 1,
    assistantMessages: 1,
    tokensByModel: {
      "claude-opus-4-5": {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1000,
        cacheWriteTtl: { fiveM: 1000 - oneHourTokens, oneH: oneHourTokens },
      },
    },
    messageTimestamps: ["2026-06-07T12:00:30.000Z"],
    toolUses: [],
    plans: [],
    compactions: [],
    apiErrors: [],
    fileModifiedAt: null,
    turnDurations: [],
    entrypoint: "claude",
    permissionMode: null,
    thinkingBlockCount: 0,
    toolResultErrors: [],
    usageExtras: {
      service_tiers: [],
      speeds: [],
      inference_geos: [],
      reasoning_output_tokens: 0,
      web_search_requests: 0,
    },
    messages: [],
    tokenSeries: [
      {
        timestamp: "2026-06-07T12:00:30.000Z",
        model: "claude-opus-4-5",
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 1000,
        cacheWriteTtl: { fiveM: 1000 - oneHourTokens, oneH: oneHourTokens },
      },
    ],
    diffStats: null,
    slashCommands: [],
    skills: [],
    hooks: [],
    artifacts: { prs: [], issues: [], repo: null },
    prLinks: [],
  });

  const sessionCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { cost_usd_estimated: number | null }[]
    >("SELECT cost_usd_estimated FROM sessions WHERE id = $1", id);
    return Number(rows[0]?.cost_usd_estimated ?? 0);
  };
  const analyticsCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<
      { est_cost: number | null }[]
    >("SELECT est_cost FROM session_analytics WHERE session_id = $1", id);
    return Number(rows[0]?.est_cost ?? 0);
  };
  const tokenRowsCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<{ s: number | null }[]>(
      "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS s FROM token_usage WHERE session_id = $1",
      id
    );
    return Number(rows[0]?.s ?? 0);
  };
  const eventRowsCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<{ s: number | null }[]>(
      "SELECT COALESCE(SUM(cost_usd_estimated), 0) AS s FROM token_events WHERE session_id = $1",
      id
    );
    return Number(rows[0]?.s ?? 0);
  };
  // The per-event cache-write lane cost (includes the premium post-FEA-3419).
  const cacheWriteCost = async (id: string): Promise<number> => {
    const rows = await db.prisma.client.$queryRawUnsafe<{ s: number | null }[]>(
      "SELECT COALESCE(SUM(cache_creation_cost_usd_estimated), 0) AS s FROM token_events WHERE session_id = $1",
      id
    );
    return Number(rows[0]?.s ?? 0);
  };
  const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

  try {
    await db.importer.importSession(makeSession("no-1h", 0), "claude");
    await db.importer.importSession(makeSession("half-1h", 400), "claude");

    const baseTokenCost = await tokenRowsCost("no-1h");
    assert.ok(baseTokenCost > 0, "opus-4-5 cache-write cost should be priced");

    // Expected premium: 400 of the 1000 cache-write tokens at 0.6x the model's
    // per-token 5m cache-write rate (derived from the all-5m session's priced
    // cache-write lane so it tracks genai-prices' actual rate).
    const perToken5m = (await cacheWriteCost("no-1h")) / 1000;
    const expectedPremium = 400 * perToken5m * 0.6;
    assert.ok(
      expectedPremium > 0,
      "premium should be non-zero for a 1h session"
    );

    // GUARD 1 (inverted from FEA-3636): the premium now LIVES in the token
    // rows — per-model token_usage carries it, and so does the per-event
    // cache-write lane. There is no separate session-level line item.
    assert.ok(
      near(await tokenRowsCost("half-1h"), baseTokenCost + expectedPremium)
    );
    assert.ok(
      near(await cacheWriteCost("half-1h"), 1000 * perToken5m + expectedPremium)
    );

    // Conservation with the premium on BOTH sides: usage cost == Σ event costs.
    assert.ok(
      near(await tokenRowsCost("half-1h"), await eventRowsCost("half-1h"))
    );
    assert.ok(near(await tokenRowsCost("no-1h"), await eventRowsCost("no-1h")));

    // The session rollup is pure Σ(token_usage): the premium appears exactly
    // once, via the token rows, never as an extra rollup term.
    assert.ok(
      near(await sessionCost("half-1h"), baseTokenCost + expectedPremium)
    );
    assert.ok(near(await sessionCost("no-1h"), baseTokenCost));
    assert.ok(
      near(
        (await sessionCost("half-1h")) - (await sessionCost("no-1h")),
        expectedPremium
      )
    );

    // GUARD 2: session_analytics.est_cost equals the authoritative total.
    assert.ok(
      near(await analyticsCost("half-1h"), baseTokenCost + expectedPremium)
    );
    assert.ok(
      near(await analyticsCost("half-1h"), await sessionCost("half-1h"))
    );
    assert.ok(near(await analyticsCost("no-1h"), baseTokenCost));

    // GUARD 3: re-importing must NOT accumulate the premium (delete+reinsert +
    // recompute-from-scratch keep it exactly once).
    await db.importer.importSession(makeSession("half-1h", 400), "claude");
    assert.ok(
      near(await sessionCost("half-1h"), baseTokenCost + expectedPremium)
    );
    assert.ok(
      near(await analyticsCost("half-1h"), baseTokenCost + expectedPremium)
    );
    assert.ok(
      near(await tokenRowsCost("half-1h"), baseTokenCost + expectedPremium)
    );
  } finally {
    await db.close();
    await rm(dir, { recursive: true, force: true });
  }
});
