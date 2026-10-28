import { invocationDurationFields } from "@repo/api/src/types/agent-component-invocation-duration";
import "server-only";

import type { SourceOccurrence } from "@repo/api/src/types/agent-component";
import { normalizeSourceOccurrenceType } from "@repo/api/src/types/agent-component";
import {
  type AgentComponentFindingsStoredFunnel,
  storedAgentComponentFindingsFunnel,
} from "@repo/api/src/types/agent-component-findings-funnel";
import type {
  AgentComponentInvocationAnchor,
  AgentComponentInvocationReadPage,
  AgentComponentInvocationReadRow,
} from "@repo/api/src/types/agent-component-invocation";
import {
  AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS,
  AgentComponentInvocationAnchorKind,
  AgentComponentInvocationAttributionSource,
  AgentComponentInvocationAttributionStatus,
  AgentComponentInvocationEvidenceClass,
  AgentComponentInvocationKind,
  AgentComponentInvocationRelationship,
  normalizeAgentComponentInvocationKey,
} from "@repo/api/src/types/agent-component-invocation";
import type { AgentComponentInvocationAncestry } from "@repo/api/src/types/agent-component-invocation-ancestry";
import { agentComponentInvocationFindingsFields } from "@repo/api/src/types/agent-component-invocation-findings";
import {
  type AgentComponentInvocationTelemetrySource,
  agentComponentInvocationTelemetryFields,
} from "@repo/api/src/types/agent-component-invocation-telemetry";
import type { Prisma, withDb } from "@repo/database";
import type { InvocationReadCursor } from "../invocation-read-cursor";
import {
  decodeInvocationReadCursor,
  encodeInvocationReadCursor,
  invocationReadCursorWhere,
} from "../invocation-read-cursor";
import { loadInvocationAncestries } from "./invocation-ancestry";

type InvocationReadInput = {
  organizationId: string;
  kind: string;
  key: string;
  inventoryIds: string[];
  /**
   * ISS-9880: a `nextCursor` from a previous page. Absent reads the head.
   * Malformed throws rather than silently restarting at the head, which would
   * loop a walking caller forever.
   */
  cursor?: string | null;
};

/**
 * ISS-11325: the funnel columns are now IN the select, read through
 * `storedAgentComponentFindingsFunnel` — the helper that already handles the
 * `bigint` Prisma hands back for a `BigInt?` column and the blank-cell case —
 * rather than being widened by hand, which is exactly what ISS-10727 said the
 * remaining half of the work was.
 *
 * They could not keep waiting: ISS-11325 publishes WHY a funnel reads what it
 * reads, and a `carried-forward` label beside no counts tells a reader nothing —
 * the whole content of that label is that a number IS there and describes an
 * EARLIER run. The keys stay optional on the type so a caller handing this
 * mapper a narrower row is not forced to invent cells.
 */
type InvocationReadDbRow = Prisma.AgentComponentInvocationGetPayload<{
  select: typeof INVOCATION_READ_SELECT;
}> &
  InvocationFindingsColumns;

type InvocationFindingsColumns = {
  findingsEmitted?: bigint | number | null;
  findingsInvalidated?: bigint | number | null;
  /** ISS-11325: WHY that pair reads what it reads. Unvalidated TEXT. */
  findingsDisposition?: string | null;
};

export type InvocationSourceOccurrenceDbRow =
  Prisma.SourceOccurrenceGetPayload<{
    select: typeof INVOCATION_SOURCE_OCCURRENCE_SELECT;
  }>;

export async function loadAgentComponentInvocationReadPage(
  db: Parameters<Parameters<typeof withDb>[0]>[0],
  input: InvocationReadInput
): Promise<AgentComponentInvocationReadPage> {
  const where = invocationReadWhere(input);
  const cursor = resolveInvocationReadCursor(input.cursor);
  // ISS-9880: the continuation narrows the PAGE read only. The counts below
  // stay on the unnarrowed predicate because they describe the population, and
  // a walk to exhaustion is checked against them.
  const pageWhere =
    cursor === null
      ? where
      : { AND: [where, invocationReadCursorWhere(cursor)] };
  // ISS-9880: one row past the page so exhaustion is decided by this page's own
  // result. `total` is a separate read, so `total > rows.length` was only ever
  // right on the head page — from any cursor it reports a next page that is not
  // there.
  const [windowRows, statusCounts] = await Promise.all([
    db.agentComponentInvocation.findMany({
      where: pageWhere,
      select: INVOCATION_READ_SELECT,
      orderBy: [
        { invokedAt: { sort: "desc", nulls: "last" } },
        { generationId: "asc" },
        { sequence: "asc" },
        { externalInvocationId: "asc" },
        { id: "asc" },
      ],
      take: AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS + 1,
    }),
    db.agentComponentInvocation.groupBy({
      by: ["attributionStatus"],
      where,
      _count: { _all: true },
    }),
  ]);
  const hasMore = windowRows.length > AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS;
  const rows = hasMore
    ? windowRows.slice(0, AGENT_COMPONENT_INVOCATION_READ_MAX_ROWS)
    : windowRows;
  const lastOnPage = rows.at(-1);
  const nextCursor =
    hasMore && lastOnPage
      ? encodeInvocationReadCursor({
          invokedAtMs: lastOnPage.invokedAt?.getTime() ?? null,
          generationId: lastOnPage.generationId,
          sequence: lastOnPage.sequence,
          externalInvocationId: lastOnPage.externalInvocationId,
        })
      : null;
  const countByStatus = new Map(
    statusCounts.map((group) => [group.attributionStatus, group._count._all])
  );
  const total = statusCounts.reduce(
    (count, group) => count + group._count._all,
    0
  );
  const sourceOccurrenceIds = Array.from(
    new Set(
      rows.flatMap((row) =>
        row.sourceOccurrenceId === null ? [] : [row.sourceOccurrenceId]
      )
    )
  );
  const sourceOccurrences =
    sourceOccurrenceIds.length === 0
      ? []
      : await db.sourceOccurrence.findMany({
          where: {
            organizationId: input.organizationId,
            id: { in: sourceOccurrenceIds },
          },
          select: INVOCATION_SOURCE_OCCURRENCE_SELECT,
        });
  const sourceOccurrenceById = new Map(
    sourceOccurrences.map((occurrence) => [occurrence.id, occurrence])
  );
  // ISS-10714: an invocation's ancestors are frequently OFF this page — the read
  // is scoped by component, not by session — so the chain is resolved against
  // the generation the row belongs to rather than against the page.
  const ancestryByRowId = await loadInvocationAncestries(db, rows);
  return {
    items: rows.map((row) =>
      toInvocationReadRow(row, sourceOccurrenceById, ancestryByRowId)
    ),
    total,
    hasMore,
    ...(nextCursor === null ? {} : { nextCursor }),
    unmatchedCount:
      countByStatus.get(AgentComponentInvocationAttributionStatus.Unmatched) ??
      0,
    ambiguousCount:
      countByStatus.get(AgentComponentInvocationAttributionStatus.Ambiguous) ??
      0,
  };
}

function invocationReadWhere(
  input: InvocationReadInput
): Prisma.AgentComponentInvocationWhereInput {
  // ISS-6757: match the PERSISTED case-folded projection, not `componentKey`
  // with `mode: "insensitive"`. Prisma compiles that mode to ILIKE, which no
  // btree can serve, so this arm's only sargable predicate was
  // `agent_component_id IS NULL` — every unattributed invocation in the table,
  // across every tenant (it carries no `organization_id`; the org scope arrives
  // through the `generation` join below). Both reads under this `where` paid
  // for that, and the `groupBy` has no `take` to bound it. The equality below
  // is served by `idx_aci_kind_key_normalized_unattributed`
  // (migration 20260820140200).
  //
  // The equality also stops treating `_` and `%` in a key as ILIKE wildcards, so
  // a `code_review` detail no longer picks up `code-review`'s UNATTRIBUTED
  // invocations. Its ATTRIBUTED ones must not keep arriving either, or one
  // component detail would run on two identity rules and attribution alone would
  // decide whether an invocation shows up (whitlockk). `inventoryIds` is resolved
  // upstream by `nameLevelInventoryWhere` (content-hash-identity.ts), which
  // cannot use this projection — `agent_components` has no folded column — so it
  // escapes the LIKE metacharacters instead and lands on the same
  // case-insensitive equality by a different route.
  const fallback = {
    agentComponentId: null,
    componentKind: input.kind,
    componentKeyNormalized: normalizeAgentComponentInvocationKey(input.key),
  };
  return {
    generation: {
      activeAt: { not: null },
      completedAt: { not: null },
      session: { artifact: { organizationId: input.organizationId } },
    },
    OR:
      input.inventoryIds.length === 0
        ? [fallback]
        : [{ agentComponentId: { in: input.inventoryIds } }, fallback],
  };
}

/**
 * ISS-10737: exported so the SESSION-scoped invocation tree read
 * (`apps/api/app/agent-sessions/service/session-invocation-tree-read.ts`) maps
 * its rows with THIS function rather than a second copy that would drift from
 * it. Additive: the component-scoped read above is unchanged.
 */
export function toInvocationReadRow(
  row: InvocationReadDbRow,
  sourceOccurrenceById: ReadonlyMap<string, InvocationSourceOccurrenceDbRow>,
  ancestryByRowId: ReadonlyMap<string, AgentComponentInvocationAncestry>
): AgentComponentInvocationReadRow {
  const ancestry = ancestryByRowId.get(row.id);
  const sourceOccurrence = row.sourceOccurrenceId
    ? sourceOccurrenceById.get(row.sourceOccurrenceId)
    : undefined;
  return {
    id: row.id,
    externalInvocationId: row.externalInvocationId,
    sessionId: row.generation.agentSessionId,
    externalSessionId: row.generation.session.externalSessionId,
    sourceSessionId: row.sourceSessionId,
    ...(row.childSessionId === null
      ? {}
      : { childSessionId: row.childSessionId }),
    ...(row.parentExternalInvocationId === null
      ? {}
      : { parentExternalInvocationId: row.parentExternalInvocationId }),
    ...(row.externalAgentId === null
      ? {}
      : { externalAgentId: row.externalAgentId }),
    kind: invocationContractValue(
      row.componentKind,
      AgentComponentInvocationKind,
      "kind"
    ),
    componentKey: row.componentKey,
    ...(row.rawName === null ? {} : { rawName: row.rawName }),
    ...(row.normalizedName === null
      ? {}
      : { normalizedName: row.normalizedName }),
    relationship: invocationContractValue(
      row.relationship,
      AgentComponentInvocationRelationship,
      "relationship"
    ),
    invokedAt: row.invokedAt?.toISOString() ?? null,
    sequence: row.sequence,
    anchor: invocationReadAnchor(row.anchor),
    ...(row.providerInvocationId === null
      ? {}
      : { providerInvocationId: row.providerInvocationId }),
    status: invocationContractValue(
      row.attributionStatus,
      AgentComponentInvocationAttributionStatus,
      "status"
    ),
    evidenceClass: invocationContractValue(
      row.evidenceClass,
      AgentComponentInvocationEvidenceClass,
      "evidenceClass"
    ),
    ...invocationReadAttributionSource(row.attributionSource),
    ...invocationReadDefinitionProvenance(row, sourceOccurrence),
    ...(ancestry === undefined ? {} : { ancestry }),
    ...agentComponentInvocationFindingsFields(invocationFindingsSource(row)),
    ...agentComponentInvocationTelemetryFields(invocationTelemetrySource(row)),
    ...invocationDurationFields(row.durationMs),
  };
}

/**
 * The stored telemetry, in the shape the shared projection reads.
 *
 * Token counts persist as `BigInt` and cost as a `Decimal`, so both are widened
 * here and NOWHERE ELSE — the projection owns what may be published, this owns
 * only the representation. A count past the safe-integer range is handed over
 * as-is and refused there rather than being silently rounded into a plausible
 * number on the way.
 */
function invocationTelemetrySource(
  row: InvocationReadDbRow
): AgentComponentInvocationTelemetrySource {
  return {
    kind: row.componentKind,
    model: row.model,
    inputTokens: invocationReadBigInt(row.inputTokens),
    outputTokens: invocationReadBigInt(row.outputTokens),
    cacheReadTokens: invocationReadBigInt(row.cacheReadTokens),
    cacheWriteTokens: invocationReadBigInt(row.cacheWriteTokens),
    estimatedCost: invocationReadDecimal(row.estimatedCost),
    footprintTokens: invocationReadBigInt(row.footprintTokens),
    usageMeasurement: row.usageMeasurement,
    succeeded: row.succeeded,
  };
}

function invocationReadBigInt(value: bigint | null | undefined): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * A `numeric` column widened for the wire. UNDEFINED as well as NULL, because a
 * row that never selected the column carries neither — reading `.toNumber()` off
 * an absent column threw, which is how the existing read-row suite caught it.
 */
function invocationReadDecimal(
  value: { toNumber: () => number } | null | undefined
): number | null {
  return value === null || value === undefined ? null : value.toNumber();
}

/**
 * A stored funnel is only a funnel when BOTH counts are present. A row carrying
 * one column and not the other is not a half-measurement to be completed with a
 * zero — it is no measurement, so the pair is dropped and the read omits the
 * fields. The two null checks are the NARROWING that makes that true at the
 * type level: the columns are `number | null | undefined`, so without them
 * there is no `AgentComponentFindingsFunnel` to hand the shared projection.
 * What counts as an ADMISSIBLE pair is the projection's to decide, not this
 * function's, and is deliberately not re-stated here.
 */
function invocationFindingsSource(row: InvocationFindingsColumns): {
  funnel: AgentComponentFindingsStoredFunnel | null;
  disposition: unknown;
} {
  /* ISS-11325: the disposition travels even when the pair does not. A withheld
     row is precisely the row with no counts and a reason for it, so gating the
     reason on the counts would delete the disclosure on the only rows that need
     it. Which labels may be published beside which funnel state is the shared
     projection's decision, stated once there. */
  return {
    funnel: storedAgentComponentFindingsFunnel(
      row.findingsEmitted,
      row.findingsInvalidated
    ),
    disposition: row.findingsDisposition,
  };
}

function invocationSourceOccurrence(
  row: InvocationSourceOccurrenceDbRow
): SourceOccurrence {
  return {
    // FEA-3982: degrade an unknown/skewed persisted occurrence type to `Local`
    // via the contract's documented coercion, so a value written by a newer peer
    // (static_file/distributed/builtin_*) that this reader does not know is never
    // emitted raw — matching `normalizeSourceOccurrenceType`'s stated read-path
    // contract instead of passing the column through untouched (whitlockk review).
    occurrenceType: normalizeSourceOccurrenceType(row.occurrenceType),
    accessState: row.accessState,
    repoFullName: row.repoFullName,
    repoPath: row.repoPath,
    repoCommit: row.repoCommit,
    computeTargetId: row.computeTargetId,
    localPath: row.localPath,
    packId: row.packId,
    firstSeenAt: row.firstSeenAt.toISOString(),
    lastSeenAt: row.lastSeenAt.toISOString(),
  };
}

function invocationContractValue<T extends string>(
  value: string,
  contract: Record<string, T>,
  field: string
): T {
  const matched = Object.values(contract).find(
    (candidate) => candidate === value
  );
  if (matched === undefined) {
    throw new Error(`Invalid persisted invocation ${field}: ${value}`);
  }
  return matched;
}

function invocationReadAnchor(
  value: Prisma.JsonValue
): AgentComponentInvocationAnchor {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error("Invalid persisted invocation anchor");
  }
  const record = value as Record<string, Prisma.JsonValue>;
  switch (record.kind) {
    case AgentComponentInvocationAnchorKind.Event:
      return {
        kind: AgentComponentInvocationAnchorKind.Event,
        eventId: requiredAnchorString(record.eventId),
        ...(typeof record.providerToolUseId === "string"
          ? { providerToolUseId: record.providerToolUseId }
          : {}),
      };
    case AgentComponentInvocationAnchorKind.Agent:
      return {
        kind: AgentComponentInvocationAnchorKind.Agent,
        agentId: requiredAnchorString(record.agentId),
        ...(typeof record.externalAgentId === "string"
          ? { externalAgentId: record.externalAgentId }
          : {}),
        ...(typeof record.transcriptFileId === "string"
          ? { transcriptFileId: record.transcriptFileId }
          : {}),
      };
    case AgentComponentInvocationAnchorKind.UserTurn:
      return {
        kind: AgentComponentInvocationAnchorKind.UserTurn,
        userTurnId: requiredAnchorString(record.userTurnId),
      };
    case AgentComponentInvocationAnchorKind.Timestamp:
      return {
        kind: AgentComponentInvocationAnchorKind.Timestamp,
        timestamp: requiredAnchorString(record.timestamp),
        ordinal: requiredAnchorNumber(record.ordinal),
      };
    case AgentComponentInvocationAnchorKind.Session:
      return { kind: AgentComponentInvocationAnchorKind.Session };
    default:
      throw new Error("Invalid persisted invocation anchor kind");
  }
}

function requiredAnchorString(value: Prisma.JsonValue | undefined): string {
  if (typeof value !== "string") {
    throw new Error("Invalid persisted invocation anchor string");
  }
  return value;
}

function requiredAnchorNumber(value: Prisma.JsonValue | undefined): number {
  if (typeof value !== "number") {
    throw new Error("Invalid persisted invocation anchor number");
  }
  return value;
}

/** ISS-10737: shared with the session-scoped tree read. Additive export. */
export const INVOCATION_READ_SELECT = {
  id: true,
  externalInvocationId: true,
  // ISS-9880: not mapped onto the row — it is the second key of the read's
  // order, so the keyset cursor cannot be minted without it.
  generationId: true,
  sourceSessionId: true,
  childSessionId: true,
  parentExternalInvocationId: true,
  externalAgentId: true,
  componentKind: true,
  componentKey: true,
  rawName: true,
  normalizedName: true,
  relationship: true,
  invokedAt: true,
  sequence: true,
  anchor: true,
  providerInvocationId: true,
  attributionStatus: true,
  evidenceClass: true,
  // ISS-10720: the SECOND attribution axis. `evidenceClass` keeps saying where
  // the definition came from, so a row the harness independently named is
  // indistinguishable from a transcript-only one unless this column is read.
  attributionSource: true,
  definitionHash: true,
  normalizerContractVersion: true,
  definitionVersionId: true,
  sourceOccurrenceId: true,
  sourcePath: true,
  sourceModifiedAt: true,
  capturedAt: true,
  repositoryFullName: true,
  repositoryCommit: true,
  packId: true,
  branchName: true,
  // ISS-10718: the telemetry columns exist and never reached a reader. They are
  // selected here so the read row can carry them; an absent value stays NULL and
  // the projection omits it rather than publishing a confident zero.
  model: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  durationMs: true,
  footprintTokens: true,
  usageMeasurement: true,
  succeeded: true,
  // ISS-10725 persisted the funnel and ISS-11325 selects it: the counts, plus the
  // statement about them. An absent pair stays NULL and the projection omits the
  // fields rather than publishing a confident zero.
  findingsEmitted: true,
  findingsInvalidated: true,
  findingsDisposition: true,
  generation: {
    select: {
      agentSessionId: true,
      session: { select: { externalSessionId: true } },
    },
  },
} satisfies Prisma.AgentComponentInvocationSelect;

/** ISS-10737: shared with the session-scoped tree read. Additive export. */
export const INVOCATION_SOURCE_OCCURRENCE_SELECT = {
  id: true,
  occurrenceType: true,
  accessState: true,
  repoFullName: true,
  repoPath: true,
  repoCommit: true,
  computeTargetId: true,
  localPath: true,
  packId: true,
  firstSeenAt: true,
  lastSeenAt: true,
} satisfies Prisma.SourceOccurrenceSelect;

/**
 * A cursor this read minted, or `null` for no cursor at all. A token that does
 * not decode THROWS rather than falling back to the head: a walking caller
 * silently restarted at row 1 never terminates.
 *
 * ONLY `null` and `undefined` mean "no cursor". An EMPTY STRING is a malformed
 * token and throws with the rest of them — a truthiness test sent `""` down the
 * head branch, which is the silent restart this contract exists to refuse, and
 * `?cursor=` is exactly what a query parameter produces (whitlockk review).
 */
function resolveInvocationReadCursor(
  raw: string | null | undefined
): InvocationReadCursor | null {
  if (raw === null || raw === undefined) {
    return null;
  }
  const cursor = decodeInvocationReadCursor(raw);
  if (cursor === null) {
    throw new Error("Invalid invocation read cursor");
  }
  return cursor;
}

/**
 * Where this invocation's DEFINITION came from, as optional wire keys.
 *
 * Extracted from {@link toInvocationReadRow} when ISS-10720's
 * `attributionSource` arm pushed that function to a cognitive complexity of 21.
 * These eleven fields are one concern — the definition's provenance and the
 * on-disk pointer `genuineSourceOccurrence` builds from it — and the
 * `attributionSource` arm deliberately is NOT among them: that answers WHO
 * attributed the row, which is the other axis.
 *
 * Every field is omitted rather than sent as `null`, which is the shape each
 * has had on this read since it shipped.
 */
function invocationReadDefinitionProvenance(
  row: InvocationReadDbRow,
  sourceOccurrence: InvocationSourceOccurrenceDbRow | undefined
): Partial<AgentComponentInvocationReadRow> {
  return {
    ...(row.definitionHash === null
      ? {}
      : { definitionHash: row.definitionHash }),
    ...(row.normalizerContractVersion === null
      ? {}
      : { normalizerContractVersion: row.normalizerContractVersion }),
    ...(row.definitionVersionId === null
      ? {}
      : { definitionVersionId: row.definitionVersionId }),
    ...(sourceOccurrence
      ? { sourceOccurrence: invocationSourceOccurrence(sourceOccurrence) }
      : {}),
    ...(row.sourcePath === null ? {} : { sourcePath: row.sourcePath }),
    ...(row.sourceModifiedAt === null
      ? {}
      : { sourceModifiedAt: row.sourceModifiedAt.toISOString() }),
    ...(row.capturedAt === null
      ? {}
      : { capturedAt: row.capturedAt.toISOString() }),
    ...(row.repositoryFullName === null
      ? {}
      : { repositoryFullName: row.repositoryFullName }),
    ...(row.repositoryCommit === null
      ? {}
      : { repositoryCommit: row.repositoryCommit }),
    ...(row.packId === null ? {} : { packId: row.packId }),
    ...(row.branchName === null ? {} : { branchName: row.branchName }),
  };
}

/**
 * WHO attributed this invocation to its component, as an optional wire key.
 *
 * ABSENT AND NULL ARE THE SAME ANSWER and neither is an error. `NULL` means the
 * transcript attributed the row — every row written before ISS-10720's
 * migration, and every row its join does not reach — and a projection that did
 * not select the column at all is saying no more and no less than that. The
 * first cut compared against `null` only, so an absent cell reached
 * `invocationContractValue` and threw `Invalid persisted invocation
 * attributionSource: undefined`, which fails the WHOLE invocation page over one
 * optional cell that was never populated in the first place.
 */
function invocationReadAttributionSource(value: string | null | undefined): {
  attributionSource?: AgentComponentInvocationAttributionSource;
} {
  if (value === null || value === undefined) {
    return {};
  }
  return {
    attributionSource: invocationContractValue(
      value,
      AgentComponentInvocationAttributionSource,
      "attributionSource"
    ),
  };
}
