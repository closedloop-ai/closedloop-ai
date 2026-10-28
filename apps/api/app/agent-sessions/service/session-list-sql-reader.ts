/**
 * ISS-8554 / PLN-1853 Phase 3 (revision 13, D15 amended) — the SQL-native
 * single-rule AND compound (two-to-four-rule) list sort.
 *
 * D15 amended: a sort request takes this path when it is a single rule on a
 * column below, OR a compound chain of two to four rules that the live page is
 * served IN MEMORY (see {@link resolveSqlNativeCompoundSortRequest} for why an
 * all-DB-native chain is excluded). A chain of five-plus distinct columns
 * (capped outright by the twelve-column vocabulary, since
 * `resolveSessionSortRules` dedupes by column) keeps the existing in-memory
 * path (`session-display-sort.ts` / `session-candidate-stream.ts` /
 * `session-sort-comparators.ts`) untouched — nothing here replaces it.
 *
 * EVERY ORDERING HERE MIRRORS THE IN-MEMORY COMPARATORS, never the Prisma
 * `orderBy` arm. That is why each statement's text keys carry `COLLATE "C"`:
 * `compareStrings` and `compareOwnerDisplayNameKeys` compare with a plain `<`
 * on code units, which the database's own collation does not reproduce.
 *
 * This module returns each row's `artifact_id` plus its `recordUpdatedAtMs`
 * witness key for the requested `[offset, offset + limit)` window, nothing
 * else. The caller still reads `total`/`idleCount` through the existing Prisma
 * `count(where)` calls and still hydrates the full row shape through the
 * existing `WHERE id IN (...)` + reorder step (`hydrateSessionRows` in
 * `list-page-fetch.ts`) — this module only replaces the ORDERING.
 */

import { Prisma, sql, type TransactionClient, withDb } from "@repo/database";
import type { AgentSessionSortRule } from "../validators";
import { isMissingTeamScope } from "./query-builder";
import type { SessionListInput } from "./records";
import { resolveRecordUpdatedAt } from "./session-display-sort";
import type { ListSortPageRow } from "./session-list-sort-differ";
import {
  requiresInMemorySessionSort,
  resolveSessionSortRules,
} from "./session-sort-rules";
import { facetArgs } from "./usage-sql-reader";
import { toFacets, toWindow } from "./usage-summary-sql";

/**
 * The single-rule columns this phase has a SQL path for — all three
 * `SessionSortColumnKind.Display` columns, landed in order (`updated`,
 * `user`, `duration`).
 */
export type SqlNativeDisplaySortColumn = "duration" | "updated" | "user";

export type SqlNativeSingleSortRequest = {
  column: SqlNativeDisplaySortColumn;
  dir: "asc" | "desc";
};

/**
 * D15: whether this request's sort is a single rule on a column this phase
 * has a SQL path for — the only shape that takes the new path. `null` for
 * every other shape (no sort, a DB-native single rule — already cheap via the
 * existing `findDbPaginatedPage` — or a compound chain), which keeps taking
 * today's path unchanged.
 */
export function resolveSqlNativeSingleSortRequest(
  filters: Parameters<typeof resolveSessionSortRules>[0]
): SqlNativeSingleSortRequest | null {
  const rules = resolveSessionSortRules(filters);
  if (rules.length !== 1) {
    return null;
  }
  const [rule] = rules;
  if (
    rule.column !== "updated" &&
    rule.column !== "user" &&
    rule.column !== "duration"
  ) {
    return null;
  }
  return { column: rule.column, dir: rule.dir };
}

/**
 * The ordered page for a SINGLE sort rule on `updated` — each row's
 * `artifact_id` and the `updated` key it was ordered by.
 *
 * Empty when the caller asked for a team scope with no team id — the same
 * early return `buildWhere` takes (`isMissingTeamScope`), reproduced here
 * because this statement's facet predicates have no spelling for it.
 *
 * THE ORDER AND THE KEYS COME FROM ONE MVCC SNAPSHOT. `RepeatableRead` is what
 * makes the returned keys the keys this ordering was actually computed from:
 * `updated` is bumped by every desktop sync upsert, so keys read in a later
 * snapshot could not be held against the order (`list-page-fetch.ts` pins the
 * live page the same way, for the same reason). That is what lets the shadow's
 * verdict separate a moving key from a real ordering divergence
 * (`session-list-sort-differ.ts`).
 */
export function readSessionListPageByUpdated(
  input: SessionListInput,
  dir: "asc" | "desc",
  offset: number,
  limit: number
): Promise<ListSortPageRow[]> {
  if (isMissingTeamScope(input.filters)) {
    return Promise.resolve([]);
  }
  const window = toWindow(input);
  const facets = toFacets(input);
  return withDb.tx(
    async (tx) => {
      const rows = await tx.$queryRawTyped(
        sql.sessionListPageByUpdated(
          ...facetArgs(window, facets),
          dir === "desc",
          offset,
          limit
        )
      );
      const orderedIds = rows.map((row) => row.artifact_id);
      const keys = await readRecordUpdatedAtKeys(tx, orderedIds);
      return orderedIds.map((id) => ({
        id,
        recordUpdatedAtMs: keys.get(id) ?? null,
      }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/**
 * The ordered page for a SINGLE sort rule on `user` (or its `assignee` alias,
 * which `resolveSessionSortRules` folds into it) — the display name of the
 * session's assignee (ISS-12251 D-1), case-insensitive. Empty under the same
 * team-scope early return as {@link readSessionListPageByUpdated}.
 *
 * Direction cannot use the numeric sign-flip the `updated` statement uses — a
 * text key has no negation — so the statement carries two mutually exclusive
 * `ORDER BY` terms selected by the same boolean parameter, each with its own
 * literal `ASC`/`DESC` and `NULLS LAST`.
 *
 * The rows carry `recordUpdatedAtMs`, not the owner key the ordering was
 * computed from: the live side the shadow diffs against only ever carries that
 * one key (`route.ts`). It is a witness that the row MUTATED between the two
 * reads — an owner re-assignment bumps it — not the key this page is ordered
 * by. The `RepeatableRead` snapshot is held for the same reason as the sibling.
 */
export function readSessionListPageByUser(
  input: SessionListInput,
  dir: "asc" | "desc",
  offset: number,
  limit: number
): Promise<ListSortPageRow[]> {
  if (isMissingTeamScope(input.filters)) {
    return Promise.resolve([]);
  }
  const window = toWindow(input);
  const facets = toFacets(input);
  return withDb.tx(
    async (tx) => {
      const rows = await tx.$queryRawTyped(
        sql.sessionListPageByUser(
          ...facetArgs(window, facets),
          dir === "desc",
          offset,
          limit
        )
      );
      const orderedIds = rows.map((row) => row.artifact_id);
      const keys = await readRecordUpdatedAtKeys(tx, orderedIds);
      return orderedIds.map((id) => ({
        id,
        recordUpdatedAtMs: keys.get(id) ?? null,
      }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/**
 * The ordered page for a SINGLE sort rule on `duration` — the DISPLAYED span.
 * Empty under the same team-scope early return as
 * {@link readSessionListPageByUpdated}.
 *
 * A running row's span is measured to a MINUTE-FLOORED `now()`, the quantum
 * `durationSortClockMs` applies on the live path; the statement's header
 * carries why. The rows carry `recordUpdatedAtMs` for the same reason the
 * `user` sibling does — it witnesses that a row mutated between the two reads,
 * and is not the key this page is ordered by.
 */
export function readSessionListPageByDuration(
  input: SessionListInput,
  dir: "asc" | "desc",
  offset: number,
  limit: number
): Promise<ListSortPageRow[]> {
  if (isMissingTeamScope(input.filters)) {
    return Promise.resolve([]);
  }
  const window = toWindow(input);
  const facets = toFacets(input);
  return withDb.tx(
    async (tx) => {
      const rows = await tx.$queryRawTyped(
        sql.sessionListPageByDuration(
          ...facetArgs(window, facets),
          dir === "desc",
          offset,
          limit
        )
      );
      const orderedIds = rows.map((row) => row.artifact_id);
      const keys = await readRecordUpdatedAtKeys(tx, orderedIds);
      return orderedIds.map((id) => ({
        id,
        recordUpdatedAtMs: keys.get(id) ?? null,
      }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}

/**
 * The `updated` sort key per artifact id, resolved through the SAME helper the
 * live projection's `recordUpdatedAt` and the in-memory comparator go through
 * — so this reports the key the page is sorted by rather than a second reading
 * of what that key means.
 */
async function readRecordUpdatedAtKeys(
  tx: TransactionClient,
  artifactIds: readonly string[]
): Promise<Map<string, number | null>> {
  if (artifactIds.length === 0) {
    return new Map();
  }
  const rows = await tx.sessionDetail.findMany({
    where: { artifactId: { in: [...artifactIds] } },
    select: {
      artifactId: true,
      updatedAt: true,
      artifact: { select: { updatedAt: true } },
    },
  });
  return new Map(
    rows.map((row) => [
      row.artifactId,
      resolveRecordUpdatedAt(row)?.getTime() ?? null,
    ])
  );
}

/**
 * D15 amended (revision 13, operator ruling 2026-10-09): the two-to-four-rule
 * chain `sessionListPageByCompoundSort.sql` serves.
 */
export type SqlNativeCompoundSortRequest = {
  rules: readonly [
    AgentSessionSortRule,
    AgentSessionSortRule,
    ...AgentSessionSortRule[],
  ];
};

/**
 * Whether this request's sort is a compound chain this phase has a SQL path
 * for. `null` for a single rule (the dedicated statements above already serve
 * it), no sort, or a chain longer than four rules (the in-memory path).
 *
 * ALSO `null` FOR AN ALL-DB-NATIVE CHAIN — the one arm this statement cannot be
 * the candidate for. {@link requiresInMemorySessionSort} is the predicate the
 * LIVE page is dispatched on (`service.ts` into `resolveSessionListPage`), so
 * reading it here keeps the candidate and the served order on the same arm. The
 * two arms disagree in ways no single statement can satisfy at once: an all-DB
 * chain is ordered by Prisma under the database's own collation and carries
 * `dbColumnNarrowing`'s extra keys, while an in-memory chain is ordered by
 * `compareStrings`/`compareOwnerDisplayNameKeys` on CODE UNITS with no
 * narrowing — so a text key matching one arm logs a collation-only divergence
 * against the other (marisolashgrove and tamsinb on #8732).
 *
 * Same rule the single-rule resolver above already applies by naming only the
 * three `Display` columns, and for its second reason too: an all-DB-native
 * request is already served by one indexed Prisma query, so there is no
 * in-memory ordering there for a SQL candidate to replace.
 */
export function resolveSqlNativeCompoundSortRequest(
  filters: Parameters<typeof resolveSessionSortRules>[0]
): SqlNativeCompoundSortRequest | null {
  const rules = resolveSessionSortRules(filters);
  if (rules.length < 2 || rules.length > 4) {
    return null;
  }
  if (!requiresInMemorySessionSort(rules)) {
    return null;
  }
  return {
    rules: rules as SqlNativeCompoundSortRequest["rules"],
  };
}

function compoundSortSlot(
  rule: AgentSessionSortRule | undefined
): readonly [string | null, boolean] {
  if (!rule) {
    return [null, false];
  }
  return [rule.column, rule.dir === "desc"];
}

/**
 * The ordered page for a COMPOUND chain of two to four rules. Empty under the
 * same team-scope early return as {@link readSessionListPageByUpdated}.
 *
 * Same `RepeatableRead` + `recordUpdatedAtMs` contract as the three single-rule
 * readers above: a shadowed chain always carries at least one display column
 * (`updated`/`user`/`duration`) and may be all three, so the shadow's
 * divergence-attribution needs the same witness key here, not just on the
 * dedicated single-rule path.
 */
export function readSessionListPageByCompoundSort(
  input: SessionListInput,
  rules: readonly AgentSessionSortRule[],
  offset: number,
  limit: number
): Promise<ListSortPageRow[]> {
  if (isMissingTeamScope(input.filters)) {
    return Promise.resolve([]);
  }
  const window = toWindow(input);
  const facets = toFacets(input);
  const [slot1Column, slot1Descending] = compoundSortSlot(rules[0]);
  const [slot2Column, slot2Descending] = compoundSortSlot(rules[1]);
  const [slot3Column, slot3Descending] = compoundSortSlot(rules[2]);
  const [slot4Column, slot4Descending] = compoundSortSlot(rules[3]);
  return withDb.tx(
    async (tx) => {
      const rows = await tx.$queryRawTyped(
        sql.sessionListPageByCompoundSort(
          ...facetArgs(window, facets),
          slot1Column,
          slot1Descending,
          slot2Column,
          slot2Descending,
          slot3Column,
          slot3Descending,
          slot4Column,
          slot4Descending,
          offset,
          limit
        )
      );
      const orderedIds = rows.map((row) => row.artifact_id);
      const keys = await readRecordUpdatedAtKeys(tx, orderedIds);
      return orderedIds.map((id) => ({
        id,
        recordUpdatedAtMs: keys.get(id) ?? null,
      }));
    },
    { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }
  );
}
