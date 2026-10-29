/**
 * @file local-invocation-read.ts
 * @description The desktop-LOCAL exact-invocation-evidence read: the keyset-
 * paged row query and the uncapped status COUNT beside it, the identity SQL
 * that unions inventory ids with the unresolved key fallback, and the DB-row →
 * `AgentComponentInvocationReadRow` mapping (anchor reconstruction, evidence
 * pointer parsing, contract-value coercion). The page boundary itself is
 * `local-invocation-read-cursor.ts`.
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
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  type AgentComponentInvocationReadPage,
  type AgentComponentInvocationReadRow,
  AgentComponentInvocationRelationship,
  agentComponentInvocationContractVersion,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import { agentComponentInvocationFindingsFields } from "@repo/api/src/types/agent-component-invocation-findings";
import {
  type AgentComponentInvocationTelemetrySource,
  agentComponentInvocationTelemetryFields,
} from "@repo/api/src/types/agent-component-invocation-telemetry";
import { numberOrZero as toNumber } from "../database/db-helpers.js";
import type { DbHostPrisma } from "../database/prisma-client.js";
import { loadLocalInvocationAncestries } from "./local-invocation-ancestry.js";
import type { LocalInvocationReadCursor } from "./local-invocation-read-cursor.js";
import {
  decodeLocalInvocationReadCursor,
  encodeLocalInvocationReadCursor,
  localInvocationReadCursorSql,
} from "./local-invocation-read-cursor.js";

/** Minimal Prisma surface this reader needs (clone-safe `client` reads only). */
type InvocationReadPrisma = Pick<DbHostPrisma, "client">;

export type LocalInvocationReadDbRow = {
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
  durationMs?: bigint | number | null;
  sequence: bigint | number;
  anchor_kind: string;
  anchor_value: string;
  provider_tool_use_id: string | null;
  attribution_status: string;
  evidence_class: string;
  /** ISS-10720: the SECOND attribution axis; NULL means the transcript. */
  attribution_source: string | null;
  evidence_pointer: string | Record<string, unknown> | null;
  definition_hash: string | null;
  normalizer_contract_version: bigint | number | null;
  local_component_version_id: string | null;
  repository_full_name: string | null;
  // ISS-10718: the desktop telemetry columns, selected below so the local read
  // carries the same numbers the cloud read does. SQLite hands INTEGER back as
  // bigint or number by magnitude, and has no boolean.
  model: string | null;
  input_tokens: bigint | number | null;
  output_tokens: bigint | number | null;
  cache_read_tokens: bigint | number | null;
  cache_write_tokens: bigint | number | null;
  estimated_cost: number | null;
  footprint_tokens: bigint | number | null;
  usage_measurement: string | null;
  succeeded: boolean | number | null;
  /**
   * ISS-10727 left these OPTIONAL because the desktop schema had no funnel
   * columns; ISS-10725's migration added them and ISS-11325 puts them in the
   * SELECT, because a `carried-forward` label beside no counts states nothing a
   * reader can act on — the point of the label is that a number IS there and is
   * not this run's. Still optional so a caller passing a narrower row (the
   * mapper's own unit tests) is not forced to invent cells.
   */
  findings_emitted?: bigint | number | null;
  findings_invalidated?: bigint | number | null;
  /**
   * ISS-11325: WHY that pair reads what it reads. NULL or an unplaceable member
   * resolves to `unrecorded` at the shared projection, which omits the key.
   */
  findings_disposition?: string | null;
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
  /**
   * ISS-10640: a `nextCursor` from a previous page. Absent reads the head.
   * Malformed throws rather than silently restarting at the head, which would
   * loop a walking caller forever.
   */
  cursor?: string | null
): Promise<AgentComponentInvocationReadPage | undefined> {
  // Resolved before any query: a malformed token is a caller bug whatever the
  // population turns out to be, and the `undefined` return below would
  // otherwise swallow it on a source that records no evidence.
  const position = resolveLocalInvocationReadCursor(cursor);
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

  // ISS-10640: the continuation narrows the PAGE read only. The counts below
  // stay on the unnarrowed predicate because they describe the population the
  // caption prints, not the page.
  //
  // They are NOT a termination condition. `total` is re-read on every page
  // while the collectors keep writing, and a row inserted mid-walk with a
  // newer `invoked_at` sorts BEFORE the cursor under `invoked_at DESC`, so it
  // reaches no page this walk will see and still lands in the next page's
  // count. `walked.length === total` therefore never settles on a store that
  // is never quiescent; `hasMore` is what decides exhaustion.
  const pageSql =
    position === null
      ? { clause: identity.clause, params: [...identity.params] }
      : localInvocationPageSql(identity, position);

  const [windowRows, countRows] = await Promise.all([
    prisma.client.$queryRawUnsafe<LocalInvocationReadDbRow[]>(
      `SELECT ${LOCAL_INVOCATION_READ_COLUMNS}
         FROM agent_component_invocations
        WHERE ${pageSql.clause}
        ORDER BY invoked_at IS NULL ASC, invoked_at DESC, session_id ASC,
                 sequence ASC, external_invocation_id ASC, id ASC
        LIMIT ${AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS + 1}`,
      ...pageSql.params
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
  // ISS-10640: one row past the page so exhaustion is decided by this page's
  // own result. `total` is a separate read over the whole population, so
  // `total > rows.length` was only ever right on the head page — from any
  // cursor it reports a next page that is not there, forever.
  const hasMore = windowRows.length > AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS;
  const rows = hasMore
    ? windowRows.slice(0, AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS)
    : windowRows;
  const counts = countRows[0];
  const total = toNumber(counts?.total);
  // `undefined` is this reader's "this data source records no exact invocation
  // evidence" — the renderer turns it into the "Evidence unavailable" empty
  // state. Only an empty ROW read supports that claim.
  //
  // ISS-5520 (whitlockk review, #4716): keying it on the count alone made the count
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
  // ISS-10714: resolved HERE and not in the row mapper — an invocation's
  // ancestors are frequently off this page, which is scoped by component rather
  // than by session, so the chain is walked against the session's whole edge set.
  const ancestryByRowId = await loadLocalInvocationAncestries(prisma, rows);
  const lastOnPage = rows.at(-1);
  const nextCursor =
    hasMore && lastOnPage
      ? encodeLocalInvocationReadCursor({
          invokedAt: lastOnPage.invoked_at,
          sessionId: lastOnPage.session_id,
          sequence: toNumber(lastOnPage.sequence),
          externalInvocationId: lastOnPage.external_invocation_id,
        })
      : undefined;
  return {
    items: rows.map((row) => toLocalInvocationReadRow(row, ancestryByRowId)),
    total,
    hasMore,
    unmatchedCount: toNumber(counts?.unmatched_count),
    ambiguousCount: toNumber(counts?.ambiguous_count),
    ...(nextCursor === undefined ? {} : { nextCursor }),
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

/**
 * ISS-10737: exported so the SESSION-scoped invocation tree read
 * (`shared-agent-session-invocation-tree-read.ts`) maps its rows with THIS
 * function instead of a second copy that would drift from it. Additive; the
 * component-scoped read above is unchanged.
 */
export function toLocalInvocationReadRow(
  row: LocalInvocationReadDbRow,
  ancestryByRowId: ReadonlyMap<string, AgentComponentInvocationAncestry>
): AgentComponentInvocationReadRow {
  const ancestry = ancestryByRowId.get(row.id);
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
  // ISS-7580: a contract version is an identity, not a count, so it takes the
  // shared version parser rather than any numeric coercion. `numberOrZero` maps
  // an unreadable cell to 0 and even a null-degrading coercion reads a BLANK
  // cell as a finite 0 — both land a PLAUSIBLE wrong version on the wire, which
  // the strict boundary schema then rejects wholesale. The sync-item producer
  // reads the same column through the same function so the two cannot disagree.
  const normalizerContractVersion = agentComponentInvocationContractVersion(
    row.normalizer_contract_version
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
    ...invocationDurationFields(row.durationMs),
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
    ...localInvocationAttributionSource(row.attribution_source),
    ...(row.definition_hash === null
      ? {}
      : { definitionHash: row.definition_hash }),
    ...(normalizerContractVersion === undefined
      ? {}
      : { normalizerContractVersion }),
    ...(row.local_component_version_id === null
      ? {}
      : { definitionVersionId: row.local_component_version_id }),
    ...(sourcePath === undefined ? {} : { sourcePath }),
    ...(sourceModifiedAt === undefined ? {} : { sourceModifiedAt }),
    ...(capturedAt === undefined ? {} : { capturedAt }),
    ...(row.repository_full_name === null
      ? {}
      : { repositoryFullName: row.repository_full_name }),
    ...(ancestry === undefined ? {} : { ancestry }),
    ...agentComponentInvocationFindingsFields(
      localInvocationFindingsSource(row)
    ),
    ...agentComponentInvocationTelemetryFields(
      localInvocationTelemetrySource(row)
    ),
  };
}

/**
 * The stored telemetry, in the shape the shared projection reads. This narrows
 * SQLite's representations and nothing else — what may be PUBLISHED is the
 * projection's decision, so the two surfaces cannot come to disagree about it.
 */
function localInvocationTelemetrySource(
  row: LocalInvocationReadDbRow
): AgentComponentInvocationTelemetrySource {
  return {
    kind: row.component_kind,
    model: row.model,
    inputTokens: localInvocationBigInt(row.input_tokens),
    outputTokens: localInvocationBigInt(row.output_tokens),
    cacheReadTokens: localInvocationBigInt(row.cache_read_tokens),
    cacheWriteTokens: localInvocationBigInt(row.cache_write_tokens),
    estimatedCost: row.estimated_cost,
    footprintTokens: localInvocationBigInt(row.footprint_tokens),
    usageMeasurement: row.usage_measurement,
    succeeded: localInvocationSucceeded(row.succeeded),
  };
}

function localInvocationBigInt(value: bigint | number | null): number | null {
  if (value === null) {
    return null;
  }
  return typeof value === "bigint" ? Number(value) : value;
}

/**
 * SQLite has no boolean. NULL stays null ("not a fact this kind records") and
 * any byte outside the closed two-value domain is refused rather than read as a
 * confident `false`.
 */
function localInvocationSucceeded(
  value: boolean | number | null
): boolean | null {
  if (typeof value === "boolean") {
    return value;
  }
  if (value === 1 || value === 0) {
    return value === 1;
  }
  return null;
}

/**
 * A stored funnel is only a funnel when BOTH counts are present. SQLite hands an
 * integer column back as `bigint` or `number` depending on magnitude, so this
 * narrows the representation and NOTHING ELSE — what counts as an admissible
 * findings count is owned by `agentComponentFindingsCountSchema`, reached
 * through the shared projection, and re-stating that rule here is how the two
 * surfaces would come to disagree about which stored rows read `measured`.
 */
function localInvocationFindingsSource(
  row: Pick<
    LocalInvocationReadDbRow,
    "findings_emitted" | "findings_invalidated" | "findings_disposition"
  >
): {
  funnel: { findingsEmitted: number; findingsInvalidated: number } | null;
  disposition: unknown;
} {
  const findingsEmitted = localInvocationFindingsCount(row.findings_emitted);
  const findingsInvalidated = localInvocationFindingsCount(
    row.findings_invalidated
  );
  /* ISS-11325: the disposition is handed over UNVALIDATED and, crucially, even
     when the pair is absent — a withheld row is exactly the row with no counts
     and a reason, and gating the reason on the counts would delete the
     disclosure on the only rows that need it. The projection owns which labels
     may be published beside which funnel state. */
  const disposition = row.findings_disposition;
  if (findingsEmitted === undefined || findingsInvalidated === undefined) {
    return { funnel: null, disposition };
  }
  return { funnel: { findingsEmitted, findingsInvalidated }, disposition };
}

function localInvocationFindingsCount(
  value: bigint | number | null | undefined
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  return typeof value === "bigint" ? Number(value) : value;
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

/**
 * ONLY `null` and `undefined` mean "no cursor". An EMPTY STRING is a malformed
 * token and throws with the rest of them — a truthiness test would send `""`
 * down the head branch, which is the silent restart this contract refuses.
 */
function resolveLocalInvocationReadCursor(
  raw: string | null | undefined
): LocalInvocationReadCursor | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const position = decodeLocalInvocationReadCursor(raw);
  if (position === null) {
    throw new Error("Invalid local invocation read cursor");
  }
  return position;
}

function localInvocationPageSql(
  identity: LocalInvocationIdentitySql,
  position: LocalInvocationReadCursor
): { clause: string; params: (string | number)[] } {
  const after = localInvocationReadCursorSql(position);
  return {
    clause: `${identity.clause} AND ${after.clause}`,
    params: [...identity.params, ...after.params],
  };
}

/**
 * ISS-10737: the column list both invocation reads project, named once so the
 * component-scoped read above and the session-scoped tree read cannot select
 * different columns into one shared {@link LocalInvocationReadDbRow} shape — a
 * divergence `tsc` cannot see, because a missing column is an `undefined` cell
 * at runtime rather than a type error.
 */
export const LOCAL_INVOCATION_READ_COLUMNS = `id, session_id, external_invocation_id, child_session_id,
       component_kind, component_key, raw_name, normalized_name,
       relationship, invoked_at, duration_ms AS durationMs, sequence, anchor_kind, anchor_value,
       provider_tool_use_id, attribution_status, evidence_class,
       attribution_source,
       evidence_pointer, definition_hash, normalizer_contract_version,
       local_component_version_id, repository_full_name,
       model, input_tokens, output_tokens, cache_read_tokens,
       cache_write_tokens, estimated_cost, footprint_tokens,
       usage_measurement, succeeded,
       findings_emitted, findings_invalidated, findings_disposition`;

/**
 * WHO attributed this invocation to its component, as an optional wire key.
 *
 * The desktop twin of `invocationReadAttributionSource`
 * (`apps/api/app/agent-components/service/invocation-read.ts`), and it had the
 * same defect for the same reason: the two paths are meant to be equivalent, so
 * the fix belongs on both. ABSENT AND NULL ARE THE SAME ANSWER and neither is
 * an error — NULL means the transcript attributed the row, and a projection
 * that does not carry the column is saying no more and no less than that.
 * Comparing against `null` alone let an absent cell reach
 * `localInvocationContractValue` and throw, failing the WHOLE local invocation
 * page over one optional cell.
 */
function localInvocationAttributionSource(value: string | null | undefined): {
  attributionSource?: AgentComponentInvocationAttributionSource;
} {
  if (value === null || value === undefined) {
    return {};
  }
  return {
    attributionSource: localInvocationContractValue(
      value,
      AgentComponentInvocationAttributionSource,
      "attributionSource"
    ),
  };
}
