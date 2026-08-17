/**
 * @file local-invocation-read.ts
 * @description The desktop-LOCAL exact-invocation-evidence read: the bounded
 * row query and the uncapped status COUNT beside it, the identity SQL that
 * unions inventory ids with the unresolved key fallback, and the DB-row →
 * `AgentComponentInvocationReadRow` mapping (anchor reconstruction, evidence
 * pointer parsing, contract-value coercion).
 *
 * Split out of `shared-agent-components-api.ts` (ISS-5520, #4716) — that module
 * is on `biome.jsonc`'s shrink-only file-size grandfather list, and this cluster
 * is a self-contained responsibility whose only entry point from the detail
 * readers is {@link readAgentComponentInvocationPage}. Nothing else in the
 * parent module referenced the rest of it.
 */

import { normalizeComponentKey } from "@repo/api/src/types/agent-component-analytics";
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  type AgentComponentInvocationAnchor,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
} from "@repo/api/src/types/agent-component-invocation";
import {
  type BranchDefaultEligibilitySnapshot,
  type BranchDefaultEligibilitySource,
  isEligibleBranchKey,
  resolveBranchDefaultEligibilitySnapshot,
} from "../branch/shared-branches-default-eligibility.js";
import { numberOrZero as toNumber } from "../database/db-helpers.js";
import type { DbHostPrisma } from "../database/prisma-client.js";

/** Minimal Prisma surface this reader needs (clone-safe `client` reads only). */
type InvocationReadPrisma = Pick<DbHostPrisma, "client">;

type LocalInvocationReadDbRow = {
  id: string;
  session_id: string;
  external_invocation_id: string;
  child_session_id: string | null;
  component_kind: string;
  component_key: string;
  raw_name: string | null;
  normalized_name: string | null;
  relationship: string;
  invoked_at: string | null;
  sequence: bigint | number;
  anchor_kind: string;
  anchor_value: string;
  provider_tool_use_id: string | null;
  attribution_status: string;
  evidence_class: string;
  evidence_pointer: string | Record<string, unknown> | null;
  definition_hash: string | null;
  normalizer_contract_version: bigint | number | null;
  local_component_version_id: string | null;
  git_branch: string | null;
  repository_full_name: string | null;
};

type LocalInvocationStatusCounts = {
  total: bigint | number | null;
  unmatched_count: bigint | number | null;
  ambiguous_count: bigint | number | null;
};

type LocalInvocationIdentitySql = {
  clause: string;
  params: string[];
};

export async function readAgentComponentInvocationPage(
  prisma: InvocationReadPrisma,
  kind: string,
  normalizedKey: string,
  inventoryIds: string[],
  branchEligibilitySource?: BranchDefaultEligibilitySource
): Promise<AgentComponentInvocationReadPage | undefined> {
  const rawKeyRows = await prisma.client.$queryRawUnsafe<
    { component_key: string }[]
  >(
    `SELECT DISTINCT component_key
       FROM agent_component_invocations
      WHERE local_component_id IS NULL AND component_kind = ?`,
    kind
  );
  const fallbackKeys = rawKeyRows
    .map((row) => row.component_key)
    .filter((key) => normalizeComponentKey(key) === normalizedKey);
  const identity = localInvocationIdentitySql(inventoryIds, kind, fallbackKeys);
  if (identity.clause === "1 = 0") {
    return undefined;
  }

  const [rows, countRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<LocalInvocationReadDbRow[]>(
      `SELECT id, session_id, external_invocation_id, child_session_id,
              component_kind, component_key, raw_name, normalized_name,
              relationship, invoked_at, sequence, anchor_kind, anchor_value,
              provider_tool_use_id, attribution_status, evidence_class,
              evidence_pointer, definition_hash, normalizer_contract_version,
              local_component_version_id, git_branch, repository_full_name
         FROM agent_component_invocations
        WHERE ${identity.clause}
        ORDER BY invoked_at IS NULL ASC, invoked_at DESC, session_id ASC,
                 sequence ASC, external_invocation_id ASC, id ASC
        LIMIT ${AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS}`,
      ...identity.params
    ),
    prisma.client.$queryRawUnsafe<LocalInvocationStatusCounts[]>(
      `SELECT COUNT(*) AS total,
              SUM(CASE WHEN attribution_status = ? THEN 1 ELSE 0 END)
                AS unmatched_count,
              SUM(CASE WHEN attribution_status = ? THEN 1 ELSE 0 END)
                AS ambiguous_count
         FROM agent_component_invocations
        WHERE ${identity.clause}`,
      AgentComponentInvocationAttributionStatus.Unmatched,
      AgentComponentInvocationAttributionStatus.Ambiguous,
      ...identity.params
    ),
  ]);
  const counts = countRows[0];
  const total = toNumber(counts?.total);
  // `undefined` is this reader's "this data source records no exact invocation
  // evidence" — the renderer turns it into the "Evidence unavailable" empty
  // state. Only an empty ROW read supports that claim.
  //
  // ISS-5520 (wongk review, #4716): keying it on the count alone made the count
  // the sole authority over a page it shares with an independent query. The two
  // reads above are a `Promise.all`, NOT one transaction, so a delete landing
  // between them returns `total: 0` beside rows that were really delivered.
  // The tab then reported that this source records no evidence at all while
  // holding the evidence in hand — and it took the one endpoint of the client's
  // `total < delivered` fallback (a count of zero is the extreme case of an
  // incredible count) permanently out of reach on this surface. Rows in hand
  // outrank a count that contradicts them; the client marks the population a
  // floor from there.
  if (total === 0 && rows.length === 0) {
    return undefined;
  }
  const eligibilitySnapshot = await resolveBranchDefaultEligibilitySnapshot(
    rows.flatMap((row) =>
      row.git_branch === null
        ? []
        : [
            {
              repoFullName: row.repository_full_name,
              branchName: row.git_branch,
            },
          ]
    ),
    branchEligibilitySource,
    { scope: "detail" }
  );
  return {
    items: rows.map((row) =>
      toLocalInvocationReadRow(row, eligibilitySnapshot)
    ),
    total,
    hasMore: total > rows.length,
    unmatchedCount: toNumber(counts?.unmatched_count),
    ambiguousCount: toNumber(counts?.ambiguous_count),
  };
}

function localInvocationIdentitySql(
  inventoryIds: string[],
  kind: string,
  fallbackKeys: string[]
): LocalInvocationIdentitySql {
  const clauses: string[] = [];
  const params: string[] = [];
  if (inventoryIds.length > 0) {
    clauses.push(
      `local_component_id IN (${inventoryIds.map(() => "?").join(", ")})`
    );
    params.push(...inventoryIds);
  }
  if (fallbackKeys.length > 0) {
    clauses.push(
      `(local_component_id IS NULL AND component_kind = ? AND component_key IN (${fallbackKeys
        .map(() => "?")
        .join(", ")}))`
    );
    params.push(kind, ...fallbackKeys);
  }
  return clauses.length === 0
    ? { clause: "1 = 0", params: [] }
    : { clause: `(${clauses.join(" OR ")})`, params };
}

function toLocalInvocationReadRow(
  row: LocalInvocationReadDbRow,
  eligibilitySnapshot: BranchDefaultEligibilitySnapshot | null
): AgentComponentInvocationReadRow {
  const pointer = parseLocalInvocationEvidencePointer(row.evidence_pointer);
  const externalAgentId = localInvocationPointerString(
    pointer,
    "externalAgentId"
  );
  const parentExternalInvocationId = localInvocationPointerString(
    pointer,
    "parentExternalInvocationId"
  );
  const transcriptFileId = localInvocationPointerString(
    pointer,
    "transcriptFileId"
  );
  const sourcePath = localInvocationPointerString(pointer, "sourcePath");
  const sourceModifiedAt = localInvocationPointerString(
    pointer,
    "sourceModifiedAt"
  );
  const capturedAt = localInvocationPointerString(pointer, "capturedAt");
  const branchName = row.git_branch;
  const branchEligible =
    branchName !== null &&
    isEligibleBranchKey(
      {
        repoFullName: row.repository_full_name,
        branchName,
      },
      eligibilitySnapshot
    );
  return {
    id: row.id,
    externalInvocationId: row.external_invocation_id,
    sessionId: row.session_id,
    externalSessionId: row.session_id,
    sourceSessionId: row.session_id,
    ...(row.child_session_id === null
      ? {}
      : { childSessionId: row.child_session_id }),
    ...(parentExternalInvocationId === undefined
      ? {}
      : { parentExternalInvocationId }),
    ...(externalAgentId === undefined ? {} : { externalAgentId }),
    kind: localInvocationContractValue(
      row.component_kind,
      AgentComponentInvocationKind,
      "kind"
    ),
    componentKey: row.component_key,
    ...(row.raw_name === null ? {} : { rawName: row.raw_name }),
    ...(row.normalized_name === null
      ? {}
      : { normalizedName: row.normalized_name }),
    relationship: localInvocationContractValue(
      row.relationship,
      AgentComponentInvocationRelationship,
      "relationship"
    ),
    invokedAt: row.invoked_at,
    sequence: toNumber(row.sequence),
    anchor: localInvocationReadAnchor(row, externalAgentId, transcriptFileId),
    ...(row.provider_tool_use_id === null
      ? {}
      : { providerInvocationId: row.provider_tool_use_id }),
    status: localInvocationContractValue(
      row.attribution_status,
      AgentComponentInvocationAttributionStatus,
      "status"
    ),
    evidenceClass: localInvocationContractValue(
      row.evidence_class,
      AgentComponentInvocationEvidenceClass,
      "evidenceClass"
    ),
    ...(row.definition_hash === null
      ? {}
      : { definitionHash: row.definition_hash }),
    ...(row.normalizer_contract_version === null
      ? {}
      : {
          normalizerContractVersion: toNumber(row.normalizer_contract_version),
        }),
    ...(row.local_component_version_id === null
      ? {}
      : { definitionVersionId: row.local_component_version_id }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(row.repository_full_name === null
      ? {}
      : { repositoryFullName: row.repository_full_name }),
    ...(branchEligible && branchName !== null ? { branchName } : {}),
  };
}

function localInvocationReadAnchor(
  row: Pick<
    LocalInvocationReadDbRow,
    "anchor_kind" | "anchor_value" | "provider_tool_use_id"
  >,
  externalAgentId: string | undefined,
  transcriptFileId: string | undefined
): AgentComponentInvocationAnchor {
  switch (row.anchor_kind) {
    case AgentComponentInvocationAnchorKind.Event:
      return {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: row.anchor_value,
        ...(row.provider_tool_use_id === null
          ? {}
          : { providerToolUseId: row.provider_tool_use_id }),
      };
    case AgentComponentInvocationAnchorKind.Agent:
      return {
        kind: AgentComponentInvocationAnchorKind.Agent,
        agentId: row.anchor_value,
        ...(externalAgentId === undefined ? {} : { externalAgentId }),
        ...(transcriptFileId === undefined ? {} : { transcriptFileId }),
      };
    case AgentComponentInvocationAnchorKind.UserTurn:
      return {
        kind: AgentComponentInvocationAnchorKind.UserTurn,
        userTurnId: row.anchor_value,
      };
    case AgentComponentInvocationAnchorKind.Timestamp:
      return {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        ...parseLocalTimestampAnchor(row.anchor_value),
      };
    case AgentComponentInvocationAnchorKind.Session:
      return { kind: AgentComponentInvocationAnchorKind.Session };
    default:
      throw new Error(
        `Invalid persisted local invocation anchor kind: ${row.anchor_kind}`
      );
  }
}

function parseLocalTimestampAnchor(value: string): {
  timestamp: string;
  ordinal: number;
} {
  try {
    const parsed = JSON.parse(value) as {
      timestamp?: unknown;
      ordinal?: unknown;
    };
    if (
      typeof parsed.timestamp === "string" &&
      typeof parsed.ordinal === "number"
    ) {
      return { timestamp: parsed.timestamp, ordinal: parsed.ordinal };
    }
  } catch {
    // Preserve legacy timestamp-only anchors conservatively.
  }
  return { timestamp: value, ordinal: 0 };
}

function parseLocalInvocationEvidencePointer(
  value: LocalInvocationReadDbRow["evidence_pointer"]
): Record<string, unknown> | null {
  if (value === null) {
    return null;
  }
  if (typeof value === "object") {
    return Array.isArray(value) ? null : value;
  }
  try {
    const parsed: unknown = JSON.parse(value);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

function localInvocationPointerString(
  pointer: Record<string, unknown> | null,
  key: string
): string | undefined {
  const value = pointer?.[key];
  return typeof value === "string" ? value : undefined;
}

function localInvocationContractValue<T extends string>(
  value: string,
  contract: Record<string, T>,
  field: string
): T {
  const matched = Object.values(contract).find(
    (candidate) => candidate === value
  );
  if (matched === undefined) {
    throw new Error(`Invalid persisted local invocation ${field}: ${value}`);
  }
  return matched;
}
