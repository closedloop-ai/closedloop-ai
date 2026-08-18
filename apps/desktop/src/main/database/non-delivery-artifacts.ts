/**
 * @file non-delivery-artifacts.ts
 * @description The ONE definition of "artifacts whose only session links are
 * NON-DELIVERY evidence" — the delivery-population gate FEA-3585 and ISS-5764
 * established — plus the two halves of applying it: the aggregate that resolves
 * the id set, and the pure predicate that excludes that set from a statement.
 *
 * ISS-5936: this used to live in `db-helpers.ts` as a single
 * `nonDeliveryOnlyArtifactIdsSubquery()` string pasted into nine production
 * statements as an uncorrelated `NOT IN (SELECT … GROUP BY … HAVING …)`. Seven
 * of those nine are one Delivery Insights load's `Promise.all`, so a single
 * dashboard load re-ran the same whole-table aggregate over
 * `session_artifact_links` SEVEN times — measured at 164ms against a live
 * 3.4k-artifact / 14.8k-link corpus, versus 20.9ms resolving once (7.9x).
 * `idx_sal_artifact` covers only `artifact_id`, not the `relation`/`method` the
 * `HAVING` reads, so every group also paid a row fetch.
 *
 * Callers now resolve the id set ONCE per call and render it into each
 * statement, so the aggregate runs once no matter how many statements the gate
 * guards. It lives here rather than in `db-helpers.ts` because
 * {@link resolveNonDeliveryOnlyArtifactIds} executes a query, and that file
 * documents itself as pure functions with no database dependency.
 */
import {
  ArtifactRefRelation,
  PROSE_MENTION_REF_METHODS,
} from "@repo/api/src/types/session-artifact-link";
import { sqlStringList } from "./db-constants.js";
import type { DesktopPrismaReader } from "./prisma-client.js";

/**
 * Ceiling on ids rendered as inline SQL literals before
 * {@link excludeNonDeliveryOnlyArtifacts} falls back to the subquery form.
 *
 * Inlining does not "avoid" SQLite's 999-bind limit — it REPLACES a documented
 * bind cap with an undocumented SQL-TEXT cap, so the list has to be bounded on
 * its own terms. Measured against a 288.7ms status-quo baseline (7 statements,
 * each re-running the aggregate) on the live corpus:
 *
 * |    ids | SQL text | 7 statements                |
 * |--------|----------|-----------------------------|
 * |  2,000 |    39 KB | 19.1ms  (~15x faster)       |
 * | 20,000 |   391 KB | 152.6ms                     |
 * | 50,000 |   977 KB | 389.8ms (SLOWER than as-is) |
 *
 * The literal form crosses back over somewhere in 20k–50k, so 2,000 keeps a
 * ~15x margin. Above it the fallback costs one extra aggregate versus the
 * status quo — the deliberate, bounded price of never emitting an unbounded
 * payload. Compare `EVENT_INSERT_PARAM_CAP` (db-constants.ts), the same
 * convention for a runtime-derived id list; a separate constant because that
 * one bounds BIND PARAMETERS and this one bounds STATEMENT TEXT.
 */
export const NON_DELIVERY_ID_INLINE_CAP = 2000;

/**
 * An id that is safe to render as an inline SQL literal.
 *
 * Escaping quotes is NOT sufficient on this stack, because `sqlStringList` is
 * not the last transform applied to the statement: every raw read goes through
 * `translateNumberedParams` (prisma-client.ts), which rewrites `$N` to `?N`
 * across the WHOLE statement text — including inside quoted literals. An id
 * containing `$1` would therefore be compared as `'…?1…'` and never match, so a
 * non-delivery-only PR would silently re-enter the delivery population: exactly
 * the failure FEA-3585 / ISS-5764 exist to prevent, and one the deleted subquery
 * form was structurally immune to because ids never left SQL.
 *
 * Production ids are 16-char md5 hex (`artifactIdFromIdentityKey`), so every
 * real id passes. But `artifacts.id` is an untyped TEXT column and this set is
 * read back out of a persisted store, so the guard is real rather than
 * theoretical. Anything outside this conservative set routes to the subquery
 * form, which cannot be corrupted by a later text rewrite — the id is EXCLUDED
 * from inlining, never dropped from the gate, so the population is unchanged.
 */
const INLINE_SAFE_ARTIFACT_ID = /^[\w.-]+$/;

function isInlineSafeArtifactId(id: string): boolean {
  return INLINE_SAFE_ARTIFACT_ID.test(id);
}

// A link that is NOT delivery evidence.
//
// FEA-3585 established the rule for `reviewed`: a PR the session examined
// read-only via `gh pr view/diff/review <n>`, never authored or worked as
// delivery. These must be excluded from the delivery-KPI population (PR
// capture / merge-rate / time-to-merge): counting a peer's reviewed-and-merged
// PR as this corpus's delivery inflates merged counts and corrupts latency.
// A PR that is BOTH reviewed here and authored/referenced elsewhere is NOT
// excluded (it stays a genuine captured PR); only artifacts with NOTHING but
// non-delivery evidence drop.
//
// ISS-5764 extends the same rule to PROSE MENTIONS, and the frozen golden corpus
// proves it is needed: once the extractor started recognizing a PR named only in
// prose, 23 mention-only PRs entered the captured population of a window the
// human-signed oracle says contains ZERO, taking time-to-merge with them. A
// mention is weaker evidence than a review, so if `reviewed` is not delivery
// then `mentioned` certainly is not.
//
// The predicate keys on METHOD, not on `relation`: `referenced` is ALSO produced
// by the long-standing URL/harness-record paths, whose PRs have always counted
// as captured delivery. Excluding that relation wholesale would silently restate
// historical metrics; excluding the two prose METHODS changes nothing for a
// corpus with no prose links.
const NON_DELIVERY_LINK_PREDICATE = `(relation = '${ArtifactRefRelation.Reviewed}' OR method IN (${sqlStringList([...PROSE_MENTION_REF_METHODS])}))`;

/**
 * The aggregate that yields every artifact whose links are ALL non-delivery.
 * One definition, shared by the resolver and by the over-cap fallback rendering,
 * so the two can never disagree about what the gate means.
 */
const NON_DELIVERY_ONLY_ARTIFACT_IDS_SQL = `SELECT artifact_id FROM session_artifact_links
             GROUP BY artifact_id
             HAVING SUM(CASE WHEN ${NON_DELIVERY_LINK_PREDICATE} THEN 1 ELSE 0 END) > 0
                AND SUM(CASE WHEN ${NON_DELIVERY_LINK_PREDICATE} THEN 0 ELSE 1 END) = 0`;

/**
 * Run {@link NON_DELIVERY_ONLY_ARTIFACT_IDS_SQL} ONCE and return the ids.
 *
 * Typed on {@link DesktopPrismaReader} rather than the whole `DesktopPrisma` so
 * it accepts both `prisma.client` and the pooled `reader` inside
 * `prisma.read(...)` — the two dispatch paths are interchangeable here, which is
 * what keeps this correct across ISS-5938's move of the Insights aggregates onto
 * the reader pool.
 *
 * Note this is deliberately NOT wrapped in a read `$transaction` with its
 * consumers. Resolving once trades statement-internal atomicity for
 * cross-statement coherence: each statement used to evaluate the gate inside its
 * own snapshot, and now they share one taken slightly earlier. ISS-5938 already
 * adjudicated a snapshot for this surface and rejected it — a read transaction
 * pins one of only two pooled readers, and a held read-mark blocks every form of
 * WAL reclaim — and recorded that these reads were already independent implicit
 * transactions, so there is no cross-statement guarantee here to preserve.
 */
export async function resolveNonDeliveryOnlyArtifactIds(
  reader: DesktopPrismaReader
): Promise<string[]> {
  const rows = await reader.$queryRawUnsafe<{ artifact_id: string }[]>(
    NON_DELIVERY_ONLY_ARTIFACT_IDS_SQL
  );
  return rows.map((row) => row.artifact_id);
}

/**
 * Render the delivery-population gate as a SQL predicate over `column`, given an
 * id set already resolved by {@link resolveNonDeliveryOnlyArtifactIds}.
 * Use as `AND ${excludeNonDeliveryOnlyArtifacts("artifacts.id", ids)}`.
 *
 * Three branches:
 * - EMPTY — a `1 = 1` no-op. Note this guards nothing at runtime: SQLite (and
 *   libSQL with it) accepts an empty `NOT IN ()` as a documented deviation from
 *   standard SQL and reads it as "in nothing", so the bare form would also be
 *   correct. It is explicit because a hot read path should not lean on a
 *   non-standard parser extension — NOT because the alternative crashes.
 *   This is the DOMINANT branch in production: the gate resolves to zero ids on
 *   a real corpus.
 * - AT OR UNDER `cap`, every id {@link INLINE_SAFE_ARTIFACT_ID} — inline
 *   literals, quotes escaped by `sqlStringList`.
 * - OVER `cap`, OR any id not inline-safe — the subquery form, from the same
 *   predicate. See {@link NON_DELIVERY_ID_INLINE_CAP}.
 *
 * `cap` is a parameter so the over-cap branch is reachable from a test; the
 * default is the only value production uses.
 */
export function excludeNonDeliveryOnlyArtifacts(
  column: string,
  ids: readonly string[],
  cap: number = NON_DELIVERY_ID_INLINE_CAP
): string {
  if (ids.length === 0) {
    return "1 = 1";
  }
  if (ids.length > cap || !ids.every(isInlineSafeArtifactId)) {
    return `${column} NOT IN (${NON_DELIVERY_ONLY_ARTIFACT_IDS_SQL})`;
  }
  return `${column} NOT IN (${sqlStringList(ids)})`;
}
