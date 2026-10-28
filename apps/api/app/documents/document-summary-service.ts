import { ArtifactType } from "@repo/api/src/types/artifact";
import type { CustomFieldQueryRejection } from "@repo/api/src/types/custom-field-list-query";
import { normalizeDocumentType } from "@repo/api/src/types/document";
import {
  DOCUMENT_METRIC_TREND_DAYS,
  DOCUMENT_SUMMARY_WINDOW_DAYS,
  type DocumentListSummary,
  type DocumentSummaryTrendlines,
  documentMetricTrendStart,
} from "@repo/api/src/types/document-list-summary";
import { ProvenanceRelationshipKind } from "@repo/api/src/types/provenance-relationship";
import {
  type Result,
  Result as ResultHelpers,
} from "@repo/api/src/types/result";
import { Prisma, withDb } from "@repo/database";
import { linkTypesForKinds } from "@/app/agent-sessions/service/provenance-eligibility";
import type { DocumentListQueryOptions } from "./custom-field-ordered-read";
import {
  buildDocumentListWhere,
  buildRecencyFilter,
  type DocumentListScopeConstraints,
} from "./document-list-query";
import {
  type DocumentMetricScopeQuery,
  resolveDocumentMetricScope,
} from "./document-metric-scope";

/**
 * ISS-8936 — the Documents index summary band's four counts.
 *
 * A sibling module rather than a method on `document-service.ts`, which is over
 * the file-size ceiling and grandfathered (`apps/api/AGENTS.md`), and beside
 * `document-list-service.ts` because it answers the same question that file's
 * `countAll` does: how big is the population this predicate describes.
 */
export const documentSummaryService = {
  /**
   * Summarize every artifact matching a document-list query.
   *
   * ONE PREDICATE, ONE INSTANT, ONE SNAPSHOT — all three, for the reason
   * `documentListService.findPageWithCustomFields` gives about its own pair. The
   * predicate is {@link buildDocumentListWhere}, the same SSOT the list's
   * `findMany` and honest total are built from, so the band cannot describe a
   * population the table was never drawn from. `now` is taken once, because the
   * freshness cutoff is derived from it and two `new Date()` calls would put the
   * total and the windowed count on cutoffs microseconds apart. And the four
   * `count()`s run inside one `RepeatableRead` transaction, so a create or delete
   * landing between them cannot make the band contradict itself — a
   * `producedByAgentSessions` greater than its own `total` is arithmetically
   * impossible for the reader to explain, and would read as a broken metric
   * rather than as a race.
   *
   * The counts are sequential rather than concurrent because a transaction pins
   * one connection and queues its statements on it anyway; a fixed fan-out of
   * four is well within the pool bound in `apps/api/AGENTS.md`.
   *
   * Sequential statements add serially, so the transaction takes
   * {@link DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS} rather than Prisma's 5s
   * interactive default — the same ceiling `withStatusCountsSnapshot` gives the
   * Sessions status counts, which are this same shape over the same kind of
   * population. Without it a large organization's provenance count alone can
   * push the fourth statement past the default and roll the whole summary back
   * as P2028, taking a band that was computable to unavailable (review thread on
   * #8000).
   */
  async summarizeScope(
    query: DocumentMetricScopeQuery,
    userId: string,
    windowDays: number = DOCUMENT_SUMMARY_WINDOW_DAYS
  ): Promise<Result<DocumentListSummary, CustomFieldQueryRejection>> {
    const now = new Date();
    return await withDb.tx(async () => {
      // ISS-12600: favorites are the caller's and custom-field facets resolve
      // to ids INSIDE this snapshot, so ids and counts describe one state.
      const options = await resolveDocumentMetricScope(query, userId, now);
      if (!options.ok) {
        return options;
      }
      return ResultHelpers.ok(
        await documentSummaryService.readSummaryInSnapshot(
          options.value,
          now,
          windowDays
        )
      );
    }, SUMMARY_SNAPSHOT_TX_OPTIONS);
  },

  /** {@link summarizeScope}, assuming an ambient snapshot and a fixed instant. */
  async readSummaryInSnapshot(
    options: DocumentSummaryOptions,
    now: Date,
    windowDays: number = DOCUMENT_SUMMARY_WINDOW_DAYS
  ): Promise<DocumentListSummary> {
    const where = buildDocumentListWhere(options, now);
    const total = await countArtifacts(where);
    const producedByAgentSessions = await countArtifacts({
      AND: [where, sessionProducedFilter(options.organizationId)],
    });
    const updatedInWindow = await countArtifacts({
      AND: [where, freshnessFilter(now, windowDays)],
    });
    const neverEdited = await countArtifacts({
      AND: [where, NEVER_EDITED_FILTER],
    });
    return {
      ...(options.artifactIds
        ? { appliedArtifactIds: [...new Set(options.artifactIds)] }
        : {}),
      ...(options.types
        ? {
            appliedTypes: [
              ...new Set(options.types.map(normalizeDocumentType)),
            ],
          }
        : {}),
      trendlines: await readSummaryTrendlines(
        where,
        options.organizationId,
        now
      ),
      total,
      producedByAgentSessions,
      updatedInWindow,
      neverEdited,
      windowDays: resolveWindowDays(windowDays),
    };
  },
};

async function countArtifacts(
  where: Prisma.ArtifactWhereInput
): Promise<number> {
  return await withDb((db) => db.artifact.count({ where }));
}

/**
 * "An agent session produced this document", as a predicate on the artifact
 * itself.
 *
 * Nested under `AND` beside the list predicate rather than spread into it: both
 * contribute top-level keys, and `buildDocumentListWhere` already emits an `OR`
 * (the archived-project slice) and an `AND` (the search slice). A spread would
 * let one silently clobber the other, which is the failure
 * `buildDocumentSearchFilter`'s own docstring is about.
 *
 * ORG-SCOPED ON BOTH ENDPOINTS — the link row and the source session — the same
 * way `sessionProvenanceLinkWhere` is, and for the same reason: a provenance
 * answer names which sessions touched which artifact, so a single unscoped
 * endpoint is a cross-tenant disclosure rather than a wrong count. The target is
 * already scoped by the list predicate this is AND-ed with.
 *
 * The link types come from `linkTypesForKinds`, the canonical kind→link_type
 * map, rather than naming `PRODUCES` here — that map is exhaustive over the kind
 * vocabulary, so a seventh kind fails `tsc` at its owner instead of silently
 * changing what this count means. `session: { isNot: null }` is what makes the
 * source a real captured session rather than an artifact merely typed SESSION.
 */
function sessionProducedFilter(
  organizationId: string
): Prisma.ArtifactWhereInput {
  return { targetLinks: { some: sessionProductionLinkWhere(organizationId) } };
}

/**
 * The freshness slice, from the predicate that already OWNS the `updatedAt`
 * window: `buildRecencyFilter` in the sibling module this service already takes
 * `buildDocumentListWhere` from.
 *
 * Called rather than re-spelled, because the ANCHOR is the part that must not
 * drift. That function's docstring is where the choice of `Artifact.updatedAt`
 * is argued, and its compile-time assertions are what pin the column as
 * non-nullable — a copy here would inherit neither, so moving the anchor there
 * would leave "Updated this week" counting the old column with nothing failing
 * (review-soul).
 */
function freshnessFilter(
  now: Date,
  windowDays: number
): Prisma.ArtifactWhereInput {
  return buildRecencyFilter(
    { recencyDays: resolveWindowDays(windowDays) },
    now
  );
}

/**
 * The window, floored at one day.
 *
 * A zero or negative window would count rows updated in the future — an empty
 * card captioned as a measurement — and a fractional one would caption "in the
 * last 1.5 days". Callers are server-side, so an out-of-range value is a
 * programming error; flooring keeps the count and the caption describing the
 * SAME window rather than letting the two disagree.
 */
function resolveWindowDays(windowDays: number): number {
  if (!Number.isFinite(windowDays)) {
    return DOCUMENT_SUMMARY_WINDOW_DAYS;
  }
  return Math.max(1, Math.floor(windowDays));
}

/**
 * "Created and never written": exactly the creation version on the document
 * detail row.
 *
 * `document: { is: … }` and not a bare relation filter — `Artifact.document` is a
 * nullable to-one, and the list predicate already narrows to document-typed
 * artifacts, so every row in the population has one. A non-document artifact
 * that somehow reached the population would be EXCLUDED here rather than counted
 * as unedited, which is the honest direction: we cannot state that a row with no
 * version counter has never been edited.
 */
const NEVER_EDITED_FILTER: Prisma.ArtifactWhereInput = {
  document: { is: { latestVersion: { lte: 1 } } },
};

/**
 * The budget the four counts share, matching
 * `STATUS_COUNTS_SNAPSHOT_TX_TIMEOUT_MS`: the same sequential-counts-in-one-
 * snapshot shape walking the same kind of population takes the same bound.
 */
export const DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS = 30_000;

/** Narrow timestamp pages preserve the exact card predicate and snapshot. */
async function readSummaryTrendlines(
  where: Prisma.ArtifactWhereInput,
  organizationId: string,
  now: Date
): Promise<DocumentSummaryTrendlines> {
  const start = documentMetricTrendStart(now);
  const trendlines: DocumentSummaryTrendlines = {
    startDate: start.toISOString(),
    endDate: now.toISOString(),
    total: new Array(DOCUMENT_METRIC_TREND_DAYS).fill(0),
    producedByAgentSessions: new Array(DOCUMENT_METRIC_TREND_DAYS).fill(0),
    updatedInWindow: new Array(DOCUMENT_METRIC_TREND_DAYS).fill(0),
  };
  // Only a row with one of its three binned timestamps on or after `start` can
  // land in a bin, so older rows are never paged.
  const recentWhere: Prisma.ArtifactWhereInput = {
    AND: [
      where,
      {
        OR: [
          { createdAt: { gte: start } },
          { updatedAt: { gte: start } },
          {
            targetLinks: {
              some: {
                ...sessionProductionLinkWhere(organizationId),
                createdAt: { gte: start },
              },
            },
          },
        ],
      },
    ],
  };
  let afterId: string | undefined;
  while (true) {
    const rows = await withDb((db) =>
      db.artifact.findMany({
        where: recentWhere,
        orderBy: { id: "asc" },
        take: 500,
        ...(afterId ? { cursor: { id: afterId }, skip: 1 } : {}),
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          targetLinks: {
            where: sessionProductionLinkWhere(organizationId),
            orderBy: { createdAt: "asc" },
            take: 1,
            select: { createdAt: true },
          },
        },
      })
    );
    for (const row of rows) {
      incrementTrend(trendlines.total, row.createdAt, start, now);
      incrementTrend(trendlines.updatedInWindow, row.updatedAt, start, now);
      const produced = row.targetLinks[0]?.createdAt;
      if (produced) {
        incrementTrend(
          trendlines.producedByAgentSessions,
          produced,
          start,
          now
        );
      }
    }
    if (rows.length < 500) {
      break;
    }
    afterId = rows.at(-1)?.id;
  }
  return trendlines;
}

function incrementTrend(values: number[], at: Date, start: Date, now: Date) {
  if (at >= start && at <= now) {
    values[Math.floor((at.getTime() - start.getTime()) / 86_400_000)] += 1;
  }
}

function sessionProductionLinkWhere(
  organizationId: string
): Prisma.ArtifactLinkWhereInput {
  return {
    organizationId,
    linkType: {
      in: linkTypesForKinds([ProvenanceRelationshipKind.Production]),
    },
    source: {
      is: {
        organizationId,
        type: ArtifactType.Session,
        session: { isNot: null },
      },
    },
  };
}

const SUMMARY_SNAPSHOT_TX_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  timeout: DOCUMENT_SUMMARY_SNAPSHOT_TX_TIMEOUT_MS,
};

type DocumentSummaryOptions = DocumentListQueryOptions &
  DocumentListScopeConstraints;
