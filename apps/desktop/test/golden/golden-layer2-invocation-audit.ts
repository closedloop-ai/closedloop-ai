import { isDeepStrictEqual } from "node:util";
import {
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationKind,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY,
  AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
} from "../../src/main/agent-sync/agent-component-invocation-sync-constants.js";
import type { NormalizedSession } from "../../src/main/collectors/types.js";
import { deriveAgentComponentInvocationCandidates } from "../../src/main/database/component-invocations.js";
import type { openTestDb } from "../agent-db-test-utils.js";
import type { GoldenDossier } from "./golden-corpus.js";
import { checkSharedInvocationRollups } from "./golden-layer2-invocation-rollup.js";

type TestDb = Awaited<ReturnType<typeof openTestDb>>;

export type SharedInvocationLayer2Input = {
  d: GoldenDossier;
  input: NormalizedSession;
  nowD: string;
};

type InvocationRow = {
  externalInvocationId: string;
  externalSourceId: string | null;
  childSessionId: string | null;
  agentId: string | null;
  parentAgentId: string | null;
  componentKind: string;
  componentKey: string;
  relationship: string;
  sequence: number;
  anchorKind: string;
  anchorValue: string;
  providerToolUseId: string | null;
  definitionHash: string | null;
  attributionStatus: string;
};

type OutboxRow = {
  sourceKey: string;
  externalSessionId: string;
  payload: unknown;
};

export async function checkSharedInvocationStores(
  db: TestDb,
  inputs: readonly SharedInvocationLayer2Input[],
  failures: string[]
): Promise<void> {
  await checkSharedInvocationAttribution(db, inputs, failures);
  await checkSharedInvocationLinks(db, failures);
  await checkSharedInvocationTransport(db, inputs, failures);
  await checkSharedInvocationRollups(db, failures);
}

async function checkSharedInvocationAttribution(
  db: TestDb,
  inputs: readonly SharedInvocationLayer2Input[],
  failures: string[]
): Promise<void> {
  for (const { d, input, nowD } of inputs) {
    const expected = deriveAgentComponentInvocationCandidates(
      input,
      `${d.sessionId}-main`,
      nowD
    ).map((candidate) => ({
      externalInvocationId: candidate.externalInvocationId,
      externalSourceId: candidate.externalSourceId,
      childSessionId: candidate.childSessionId,
      agentId: candidate.agentId,
      parentAgentId: candidate.parentAgentId,
      componentKind: candidate.componentKind,
      componentKey: candidate.componentKey,
      relationship: candidate.relationship,
      sequence: candidate.sequence,
      anchorKind: candidate.anchorKind,
      anchorValue: candidate.anchorValue,
      providerToolUseId: candidate.providerToolUseId,
      definitionHash: candidate.definitionHash,
    }));
    const actual = await db.prisma.client.$queryRawUnsafe<InvocationRow[]>(
      `SELECT external_invocation_id AS externalInvocationId,
              external_source_id AS externalSourceId,
              child_session_id AS childSessionId,
              agent_id AS agentId,
              parent_agent_id AS parentAgentId,
              component_kind AS componentKind,
              component_key AS componentKey,
              relationship,
              sequence,
              anchor_kind AS anchorKind,
              anchor_value AS anchorValue,
              provider_tool_use_id AS providerToolUseId,
              definition_hash AS definitionHash,
              attribution_status AS attributionStatus
         FROM agent_component_invocations
        WHERE session_id = $1
        ORDER BY sequence`,
      d.sessionId
    );
    const actualProjection = actual.map(
      ({ attributionStatus: _, ...row }) => row
    );
    if (!isDeepStrictEqual(actualProjection, expected)) {
      failures.push(
        `${d.sessionId}: shared-DB invocation attribution differs from the normalized input`
      );
    }
    if (
      actual.some((row) => {
        const expectedStatus = row.definitionHash
          ? AgentComponentInvocationAttributionStatus.Matched
          : AgentComponentInvocationAttributionStatus.Unresolved;
        return row.attributionStatus !== expectedStatus;
      })
    ) {
      failures.push(
        `${d.sessionId}: shared-DB invocation attribution status does not match its frozen definition evidence`
      );
    }
  }
}

async function checkSharedInvocationLinks(
  db: TestDb,
  failures: string[]
): Promise<void> {
  const [
    badComponents,
    unexpectedRuntimeSubagentComponents,
    badVersions,
    unexpectedVersions,
  ] = await Promise.all([
    // A definitionless subagent is runtime-only only while no matching
    // inventory identity exists. Once genuine inventory exists, relinking it
    // is intentional and the same exact-link invariant applies.
    db.prisma.client.$queryRawUnsafe<{ n: number | bigint }[]>(
      `SELECT COUNT(*) AS n
         FROM agent_component_invocations i
         LEFT JOIN agent_components c ON c.id = i.local_component_id
        WHERE (i.component_kind != $1
           OR i.definition_hash IS NOT NULL
           OR EXISTS (
             SELECT 1 FROM agent_components expected
              WHERE expected.component_kind = i.component_kind
                AND expected.component_key = i.component_key
           ))
          AND (i.local_component_id IS NULL
            OR c.id IS NULL
            OR c.component_kind != i.component_kind
            OR c.component_key != i.component_key)`,
      AgentComponentInvocationKind.Subagent
    ),
    db.prisma.client.$queryRawUnsafe<{ n: number | bigint }[]>(
      `SELECT COUNT(*) AS n
         FROM agent_component_invocations i
        WHERE i.component_kind = $1
          AND i.definition_hash IS NULL
          AND i.local_component_id IS NOT NULL
          AND NOT EXISTS (
            SELECT 1 FROM agent_components expected
             WHERE expected.component_kind = i.component_kind
               AND expected.component_key = i.component_key
          )`,
      AgentComponentInvocationKind.Subagent
    ),
    db.prisma.client.$queryRawUnsafe<{ n: number | bigint }[]>(
      `SELECT COUNT(*) AS n
         FROM agent_component_invocations i
         LEFT JOIN agent_component_versions v
           ON v.id = i.local_component_version_id
        WHERE i.definition_hash IS NOT NULL
          AND (i.local_component_version_id IS NULL
            OR v.id IS NULL
            OR v.component_kind != i.component_kind
            OR v.component_key != i.component_key
            OR v.content_hash != i.definition_hash)`
    ),
    db.prisma.client.$queryRawUnsafe<{ n: number | bigint }[]>(
      `SELECT COUNT(*) AS n
         FROM agent_component_invocations
        WHERE definition_hash IS NULL
          AND local_component_version_id IS NOT NULL`
    ),
  ]);
  const badComponentCount = Number(badComponents[0]?.n ?? 0);
  if (badComponentCount > 0) {
    failures.push(
      `shared-DB invocations: ${badComponentCount} component-eligible link(s) are missing or point at another identity`
    );
  }
  const unexpectedRuntimeSubagentComponentCount = Number(
    unexpectedRuntimeSubagentComponents[0]?.n ?? 0
  );
  if (unexpectedRuntimeSubagentComponentCount > 0) {
    failures.push(
      `shared-DB invocations: ${unexpectedRuntimeSubagentComponentCount} definitionless runtime-only subagent invocation(s) unexpectedly link to component inventory`
    );
  }
  const badVersionCount = Number(badVersions[0]?.n ?? 0);
  if (badVersionCount > 0) {
    failures.push(
      `shared-DB invocations: ${badVersionCount} definition-backed version link(s) are missing or mismatched`
    );
  }
  const unexpectedVersionCount = Number(unexpectedVersions[0]?.n ?? 0);
  if (unexpectedVersionCount > 0) {
    failures.push(
      `shared-DB invocations: ${unexpectedVersionCount} unresolved invocation(s) inherited an unrelated version link`
    );
  }
}

async function checkSharedInvocationTransport(
  db: TestDb,
  inputs: readonly SharedInvocationLayer2Input[],
  failures: string[]
): Promise<void> {
  const [outbox, cursors] = await Promise.all([
    db.prisma.client.$queryRawUnsafe<OutboxRow[]>(
      `SELECT source_key AS sourceKey,
              external_session_id AS externalSessionId,
              payload
         FROM agent_component_invocation_sync_outbox`
    ),
    db.prisma.client.$queryRawUnsafe<
      { sourceKey: string; externalSessionId: string }[]
    >(
      `SELECT source_key AS sourceKey,
              external_session_id AS externalSessionId
         FROM agent_component_invocation_sync_cursors`
    ),
  ]);
  const expectedSessionIds = new Set(inputs.map(({ d }) => d.sessionId));
  const outboxOwners = new Set<string>();
  for (const row of outbox) {
    const payload = parseJsonRecord(row.payload);
    outboxOwners.add(row.externalSessionId);
    if (
      row.sourceKey !== AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY ||
      !expectedSessionIds.has(row.externalSessionId) ||
      payload.externalSessionId !== row.externalSessionId
    ) {
      failures.push(
        `${row.externalSessionId}: shared-DB invocation outbox ownership or payload identity diverged`
      );
    }
  }
  for (const sessionId of expectedSessionIds) {
    if (!outboxOwners.has(sessionId)) {
      failures.push(
        `${sessionId}: shared-DB invocation outbox has no complete-generation part`
      );
    }
  }
  const cursorOwners = new Set(cursors.map((row) => row.externalSessionId));
  const allowedCursorOwners = new Set([
    ...expectedSessionIds,
    AGENT_COMPONENT_INVOCATION_SYNC_STATE_SESSION_ID,
  ]);
  if (
    cursors.some(
      (row) =>
        row.sourceKey !== AGENT_COMPONENT_INVOCATION_SYNC_SOURCE_KEY ||
        !allowedCursorOwners.has(row.externalSessionId)
    ) ||
    cursorOwners.size !== allowedCursorOwners.size ||
    [...allowedCursorOwners].some((owner) => !cursorOwners.has(owner))
  ) {
    failures.push(
      "shared-DB invocation cursors are not owned by exactly the imported sessions plus the global sync-state cursor"
    );
  }
}

function parseJsonRecord(value: unknown): Record<string, unknown> {
  let parsed = value;
  if (typeof value === "string") {
    parsed = JSON.parse(value);
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return {};
  }
  return parsed as Record<string, unknown>;
}
