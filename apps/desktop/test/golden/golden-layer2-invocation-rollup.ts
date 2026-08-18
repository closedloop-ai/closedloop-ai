import { isDeepStrictEqual } from "node:util";
import {
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import type { openTestDb } from "../agent-db-test-utils.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

type LegacyRollupInvocationRow = {
  sessionId: string;
  componentKind: string;
  componentKey: string;
  gitBranch: string | null;
  localComponentId: string | null;
  definitionHash: string | null;
  invokedAt: string | null;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId: string | null;
  rawName: string | null;
};

type LegacyRollupEventRow = {
  id: string;
  sessionId: string;
  toolName: string | null;
  gitBranch: string | null;
  providerToolUseId: string | null;
  createdAt: string;
};

type LegacyRollupEventBranches = {
  exact: ReadonlyMap<string, string | null>;
  provider: ReadonlyMap<string, string | null>;
  timestamp: ReadonlyMap<string, string | null>;
};

type UsageRow = {
  sessionId: string;
  componentKind: string;
  componentKey: string;
  gitBranch: string;
  agentComponentId: string | null;
  invocations: number | bigint;
  componentVersionHash: string | null;
  firstInvokedAt: string | null;
  lastInvokedAt: string | null;
};

export async function checkSharedInvocationRollups(
  db: TestDb,
  failures: string[]
): Promise<void> {
  const [invocations, usage, eventBranches] = await Promise.all([
    db.prisma.client.$queryRawUnsafe<LegacyRollupInvocationRow[]>(
      `SELECT session_id AS sessionId,
              component_kind AS componentKind,
              component_key AS componentKey,
              git_branch AS gitBranch,
              local_component_id AS localComponentId,
              definition_hash AS definitionHash,
              invoked_at AS invokedAt,
              anchor_kind AS anchorKind,
              anchor_value AS anchorValue,
              provider_tool_use_id AS providerToolUseId,
              raw_name AS rawName
         FROM agent_component_invocations`
    ),
    db.prisma.client.$queryRawUnsafe<UsageRow[]>(
      `SELECT session_id AS sessionId,
              component_kind AS componentKind,
              component_key AS componentKey,
              git_branch AS gitBranch,
              agent_component_id AS agentComponentId,
              invocations,
              component_version_hash AS componentVersionHash,
              first_invoked_at AS firstInvokedAt,
              last_invoked_at AS lastInvokedAt
         FROM agent_component_session_usage`
    ),
    loadLegacyRollupEventBranches(db),
  ]);
  const groups = new Map<
    string,
    {
      sessionId: string;
      componentKind: string;
      componentKey: string;
      gitBranch: string;
      componentIds: string[];
      definitionHashes: string[];
      invokedAts: string[];
      count: number;
    }
  >();
  for (const row of invocations) {
    const gitBranch = resolveLegacyUsageBranch(row, eventBranches);
    const key = JSON.stringify([
      row.sessionId,
      row.componentKind,
      row.componentKey,
      gitBranch,
    ]);
    let group = groups.get(key);
    if (!group) {
      group = {
        sessionId: row.sessionId,
        componentKind: row.componentKind,
        componentKey: row.componentKey,
        gitBranch,
        componentIds: [],
        definitionHashes: [],
        invokedAts: [],
        count: 0,
      };
      groups.set(key, group);
    }
    group.count += 1;
    if (row.localComponentId) {
      group.componentIds.push(row.localComponentId);
    }
    if (row.definitionHash) {
      group.definitionHashes.push(row.definitionHash);
    }
    if (row.invokedAt) {
      group.invokedAts.push(row.invokedAt);
    }
  }
  const expected = [...groups.entries()]
    .map(([key, group]) => {
      const uniqueHashes = new Set(group.definitionHashes);
      let componentVersionHash: string | null = null;
      if (
        group.definitionHashes.length === group.count &&
        uniqueHashes.size === 1
      ) {
        componentVersionHash = group.definitionHashes[0] ?? null;
      }
      group.componentIds.sort();
      group.invokedAts.sort();
      return {
        key,
        agentComponentId: group.componentIds.at(-1) ?? null,
        componentVersionHash,
        firstInvokedAt: group.invokedAts[0] ?? null,
        invocations: group.count,
        lastInvokedAt: group.invokedAts.at(-1) ?? null,
      };
    })
    .sort((a, b) => a.key.localeCompare(b.key));
  const actual = usage
    .map((row) => ({
      key: JSON.stringify([
        row.sessionId,
        row.componentKind,
        row.componentKey,
        row.gitBranch,
      ]),
      agentComponentId: row.agentComponentId,
      componentVersionHash: row.componentVersionHash,
      firstInvokedAt: row.firstInvokedAt,
      invocations: Number(row.invocations),
      lastInvokedAt: row.lastInvokedAt,
    }))
    .sort((a, b) => a.key.localeCompare(b.key));
  if (!isDeepStrictEqual(actual, expected)) {
    failures.push(
      "shared-DB component usage does not match the durable-invocation plus legacy event-branch projection"
    );
  }
}

async function loadLegacyRollupEventBranches(
  db: TestDb
): Promise<LegacyRollupEventBranches> {
  const rows = await db.prisma.client.$queryRawUnsafe<LegacyRollupEventRow[]>(
    `SELECT id,
            session_id AS sessionId,
            tool_name AS toolName,
            git_branch AS gitBranch,
            CASE WHEN json_type(data, '$.providerToolUseId') = 'text'
              THEN json_extract(data, '$.providerToolUseId')
              ELSE NULL
            END AS providerToolUseId,
            created_at AS createdAt
       FROM events`
  );
  return {
    exact: new Map(
      rows.map((row) => [legacyRollupKey(row.sessionId, row.id), row.gitBranch])
    ),
    provider: groupUnambiguousEventBranches(rows, (row) =>
      row.providerToolUseId
        ? legacyRollupKey(row.sessionId, row.providerToolUseId)
        : null
    ),
    timestamp: groupUnambiguousEventBranches(rows, (row) =>
      row.toolName
        ? legacyRollupKey(row.sessionId, row.createdAt, row.toolName)
        : null
    ),
  };
}

function resolveLegacyUsageBranch(
  row: LegacyRollupInvocationRow,
  branches: LegacyRollupEventBranches
): string {
  if (row.gitBranch !== null) {
    return row.gitBranch;
  }
  if (row.anchorKind === AgentComponentInvocationAnchorKind.Event) {
    const exact = branches.exact.get(
      legacyRollupKey(row.sessionId, row.anchorValue)
    );
    const provider = row.providerToolUseId
      ? branches.provider.get(
          legacyRollupKey(row.sessionId, row.providerToolUseId)
        )
      : undefined;
    return exact ?? provider ?? "";
  }
  if (row.anchorKind === AgentComponentInvocationAnchorKind.Timestamp) {
    const toolName =
      row.componentKind === AgentComponentInvocationKind.Skill
        ? "Skill"
        : row.rawName;
    if (!(row.invokedAt && toolName)) {
      return "";
    }
    return (
      branches.timestamp.get(
        legacyRollupKey(row.sessionId, row.invokedAt, toolName)
      ) ?? ""
    );
  }
  return "";
}

function groupUnambiguousEventBranches(
  rows: readonly LegacyRollupEventRow[],
  keyFor: (row: LegacyRollupEventRow) => string | null
): Map<string, string | null> {
  const grouped = new Map<string, (string | null)[]>();
  for (const row of rows) {
    const key = keyFor(row);
    if (key === null) {
      continue;
    }
    const group = grouped.get(key) ?? [];
    group.push(row.gitBranch);
    grouped.set(key, group);
  }
  const branches = new Map<string, string | null>();
  for (const [key, values] of grouped) {
    const distinct = new Set(values.map((value) => value ?? ""));
    if (distinct.size !== 1) {
      branches.set(key, null);
      continue;
    }
    const nonNull = values.filter((value) => value !== null).sort();
    branches.set(key, nonNull.at(-1) ?? null);
  }
  return branches;
}

function legacyRollupKey(...parts: string[]): string {
  return JSON.stringify(parts);
}
