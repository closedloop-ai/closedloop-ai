// ISS-7655 — the DB read behind the session attribution lenses.
//
// Split from the fold (`agent-session-attribution.ts`) because the two answer
// different questions: this module owns HOW the rows are fetched, that one owns
// what they mean.
//
// The read used to be a keyset pager over `sessionDetail` carrying a five-level
// nested `select`. Prisma resolves each relation level with its own query, so
// one usage read cost roughly ten SQL round trips PER PAGE and grew with the
// matched session count: a production trace showed 84 `postgresql.query` spans
// (a floor — the trace view truncated), 6,367 ms of query time plus 3,829 ms of
// connection acquisition, for a p75 of 6.3 s server think time.
//
// It is now three set-based reads whose count does not depend on how many
// sessions matched — links, session scalars, then the distinct link targets —
// stitched into the same record shape the fold already consumed. The three
// STAGES stay chained with sequential `await`, because each one's predicate
// needs the stage before it. ISS-6136 unpicked the sequencing WITHIN the third:
// its chunks do not depend on each other, and serializing them multiplied the
// chunk count by the several relation round trips each chunk's nested `select`
// already costs. They now run under the caller's limiter, so peak concurrency
// stays inside the FEA-3299 half-pool heuristic by BOUND rather than by
// serialization. (`withDb` does NOT hold a connection across its callback — see
// `db-fanout.ts`; the limiter, not the single `withDb`, is what bounds
// concurrency here.) The trace that argued "fewer-and-fatter beats
// more-and-parallel" spent 2,631 ms in 4 `pg.connect`, so it argued against
// MORE QUERIES; running the same chunks concurrently adds none. That span is no
// longer emitted:
// ISS-8278 set `ignoreConnectSpans` to drop the pool-checkout spans and it
// takes `pg.connect` with it. To re-measure this heuristic, read
// `db_pool_acquire_wait` samples with `@saturated:false @permitQueued:false
// @idle:0` — a handshake rather than contention (ISS-10293) — which floor at
// 10 ms.
//
// The link and session reads are bounded by matched PR-LINKED SESSIONS, not by
// distinct branches, and are deliberately uncapped: the old pager drained the
// same population, one hydrated page at a time, and capping the lenses is the
// user-visible trade ISS-7655 refuses to make. The target read is deduped to
// distinct branches and chunked, following `findMergedPrsLinkedToSessions`.
//
// ISS-12284: `readSessionAttributionBranchIds` is a second, single-statement
// read of the same population for callers that need only the distinct branch
// ids the lens keys (the Pensero numerator on `attribution=omit`). It restates
// the three stages' predicates in one `where`, so a change to what those stages
// admit must change it too; the real-DB equality test in
// `usage-summary-link-history.integration.test.ts` fails when they part.
//
// Uncapped is not unbounded ON THE WIRE: no read here puts one bind per matched
// row into a statement. Prisma's Postgres driver counts parameters in a SIGNED
// i16, so the effective ceiling is 32,767 — not the 65,535 of the wire protocol
// — and measured against this stack a 32,764-id `IN` list is the largest that
// reaches the server, while 32,765 is refused before it leaves the client. The
// session read therefore states the link predicate rather than listing source
// ids, so its parameter count does not scale with the population at all, and
// the target read chunks its deduped branch ids at LINK_BRANCH_QUERY_CHUNK_SIZE
// (500 + the predicate's own handful, two orders of magnitude under the cap).
//
// The three reads share no MVCC snapshot, so a link created or deleted between
// them can cost one session its share for one request. That is unchanged from
// the pager (each page was its own `withDb`), and `withDb.tx` is not worth a
// held connection on a dashboard read.

import { type Prisma, withDb } from "@repo/database";
import type { LimitFunction } from "p-limit";
import { createDbFanoutLimiter } from "./db-fanout";
import {
  SessionPrLinkAudience,
  sessionPrLinkFromSessions,
  sessionPrLinkWhere,
} from "./session-pr-links";
import { readInIdChunks } from "./session-pr-links-chunking";

const attributionPrDetailSelect = {
  number: true,
  title: true,
  lastVerifiedAt: true,
  repositoryFullName: true,
  repository: {
    select: {
      fullName: true,
    },
  },
} satisfies Prisma.PullRequestDetailSelect;

const attributionLinkTargetSelect = {
  organizationId: true,
  branch: {
    select: {
      branchName: true,
      repository: {
        select: {
          fullName: true,
        },
      },
      currentPullRequestDetail: {
        select: attributionPrDetailSelect,
      },
    },
  },
  pullRequestDetails: {
    select: attributionPrDetailSelect,
  },
} satisfies Prisma.ArtifactSelect;

const attributionSessionSelect = {
  artifactId: true,
  inputTokens: true,
  outputTokens: true,
  cacheReadTokens: true,
  cacheWriteTokens: true,
  estimatedCost: true,
  artifact: {
    select: {
      organizationId: true,
    },
  },
} satisfies Prisma.SessionDetailSelect;

type AttributionSessionRow = Prisma.SessionDetailGetPayload<{
  select: typeof attributionSessionSelect;
}>;

type AttributionLinkTarget = Prisma.ArtifactGetPayload<{
  select: typeof attributionLinkTargetSelect;
}>;

export type AttributionLensLink = {
  metadata: Prisma.JsonValue | null;
  targetId: string;
  target: AttributionLinkTarget;
};

/** One matched session plus the session→PR links it is attributed through. */
export type AttributionLensRecord = Omit<AttributionSessionRow, "artifact"> & {
  artifact: {
    organizationId: string;
    sourceLinks: AttributionLensLink[];
  };
};

/**
 * Every session matching `where` that carries a session→PR link, with those
 * links and their branch/PR targets hydrated.
 *
 * `organizationId` is applied as a LITERAL predicate on all three reads rather
 * than reached through the caller's `where`. Every index on `artifact_links`
 * leads with `organizationId`, so without it the link read has no usable index
 * and degrades to a cross-tenant sequential scan; the target read would have no
 * DB-side tenancy at all, leaving the fold's cross-org guard as its only line
 * of defense; and the session read must not depend on every caller remembering
 * to put the org in the `where` it passes.
 *
 * Both orders are TOTAL, because the lenses this feeds sort by cost and
 * `Array#sort` is stable: equal-cost branch and PR rows therefore tie-break on
 * the order their accumulators were first inserted, which is (session, then
 * that session's links). Sessions order by `artifactId`, the primary key. Links
 * order by `createdAt` then `id` — `createdAt` alone is not total, since links
 * written in one transaction share its timestamp, and the tie decides more than
 * row order: `sessionPrIdentityKey` normalizes a repository name, so two links
 * declaring the same PR under different spellings collapse to one identity
 * whose surviving literal is whichever came first.
 *
 * ISS-7598: `limiter` lets a caller that fans this read out ALONGSIDE other
 * reads spend one shared connection budget across all of them. The three STAGES
 * stay sequential either way — the limiter does not make them concurrent — but
 * ISS-6136 does let the target read's CHUNKS overlap within the third stage, so
 * a shared limiter is now what bounds them rather than merely accounting for
 * them.
 */
export function readSessionAttributionRecords(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction = createDbFanoutLimiter()
): Promise<AttributionLensRecord[]> {
  return withDb(async (db) => {
    const links = await limiter(() =>
      db.artifactLink.findMany({
        where: { organizationId, ...sessionPrLinkFromSessions(where) },
        select: { sourceId: true, targetId: true, metadata: true },
        orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      })
    );
    // Also the existence probe: no link means no branch to attribute to, so the
    // session and target reads never run.
    if (links.length === 0) {
      return [];
    }

    // Bounded by the same session→PR link predicate the read above ran, NOT by
    // an `IN` list of the source ids it returned. An id list spends one bind per
    // matched session, so an org whose scope matches more PR-linked sessions
    // than the driver's i16 parameter ceiling gets a 500 on a read the semi-join
    // answers in one statement with a fixed handful of binds. The literal
    // `organizationId` is the same tenancy predicate the other two reads carry,
    // rather than tenancy reached only through the caller's `where`.
    const sessions = await limiter(() =>
      db.sessionDetail.findMany({
        where: {
          AND: [
            where,
            {
              artifact: {
                organizationId,
                // ISS-5823 Metric: the attribution lenses split a session's
                // COST across its targets; prose-derived links are excluded.
                sourceLinks: {
                  some: sessionPrLinkWhere(SessionPrLinkAudience.Metric),
                },
              },
            },
          ],
        },
        select: attributionSessionSelect,
        orderBy: { artifactId: "asc" },
      })
    );

    const targetIds = [...new Set(links.map((link) => link.targetId))];
    // ISS-6136: chunked through the shared `readInIdChunks` rather than a
    // hand-rolled sequential `for`, so the chunks run under the CALLER'S
    // limiter concurrently instead of one at a time. Each chunk's nested
    // `select` costs several relation round trips of its own (Prisma resolves
    // every level as its own query), so serializing the chunks multiplied the
    // whole tree by the chunk count: a production trace of this path spent
    // ~1.1 s issuing 71 queries for 10 chunks, strictly one at a time.
    const targets = await readInIdChunks(
      targetIds,
      (chunk) =>
        db.artifact.findMany({
          where: { organizationId, id: { in: chunk } },
          select: { id: true, ...attributionLinkTargetSelect },
        }),
      limiter
    );

    return toAttributionLensRecords(links, sessions, targets);
  });
}

function toAttributionLensRecords(
  links: readonly {
    sourceId: string;
    targetId: string;
    metadata: Prisma.JsonValue | null;
  }[],
  sessions: readonly AttributionSessionRow[],
  targets: readonly (AttributionLinkTarget & { id: string })[]
): AttributionLensRecord[] {
  const targetById = new Map(targets.map(({ id, ...target }) => [id, target]));
  const linksBySessionId = new Map<string, AttributionLensLink[]>();
  for (const link of links) {
    const target = targetById.get(link.targetId);
    if (!target) {
      continue;
    }
    const sourceLinks = linksBySessionId.get(link.sourceId);
    const entry = {
      metadata: link.metadata,
      targetId: link.targetId,
      target,
    };
    if (sourceLinks) {
      sourceLinks.push(entry);
    } else {
      linksBySessionId.set(link.sourceId, [entry]);
    }
  }

  return sessions.map(({ artifact, ...scalars }) => ({
    ...scalars,
    artifact: {
      organizationId: artifact.organizationId,
      sourceLinks: linksBySessionId.get(scalars.artifactId) ?? [],
    },
  }));
}

/**
 * ISS-12284: the distinct branch ids the `byBranch` lens would key, without
 * hydrating the lens.
 *
 * The Pensero numerator needs only this set, and a request that withholds the
 * lenses (`attribution=omit`) used to pay all three stages of
 * {@link readSessionAttributionRecords}, PR-detail relations included, to learn
 * it. The predicate is the conjunction those stages apply, stated once: a
 * Metric session→PR link in this org, from a session in this org matching
 * `where`, to a target in this org that carries a branch row — exactly the
 * links `dedupeSessionBranches` keeps. One statement whose bind count does not
 * scale with the population, returning one row per distinct branch.
 */
export function readSessionAttributionBranchIds(
  organizationId: string,
  where: Prisma.SessionDetailWhereInput,
  limiter: LimitFunction = createDbFanoutLimiter()
): Promise<string[]> {
  return withDb(async (db) => {
    const branches = await limiter(() =>
      db.artifact.findMany({
        where: {
          organizationId,
          branch: { isNot: null },
          targetLinks: {
            some: {
              AND: [
                { organizationId, ...sessionPrLinkFromSessions(where) },
                { source: { organizationId } },
              ],
            },
          },
        },
        select: { id: true },
      })
    );
    return branches.map((branch) => branch.id);
  });
}
