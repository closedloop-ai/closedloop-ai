/**
 * ISS-8554 / PLN-1853 Phase 2 — facet rows to published breakdowns.
 *
 * `usage-sql-reader` returns one flat, uniform row per facet option. The
 * response contract wants five differently-shaped arrays, three of which drop
 * fields the row carries and two of which need a label the database row does not
 * have. This module is that mapping, and nothing else: it takes rows and lookup
 * maps and returns arrays. No database access, so every rule below is testable
 * without one.
 *
 * The rules are carried over from `usage-facet-projections.ts` rather than
 * re-derived, because two of them are load-bearing and neither is obvious:
 *
 *   - A row whose owner cannot be resolved is DROPPED, not rendered with a
 *     placeholder. Sessions whose owner was deleted carry a null `assignee_id`
 *     (SetNull), as do unassigned ones, and group under a null key; attributing
 *     them to anyone would be worse than omitting them. Their sessions
 *     therefore appear in `totalSessions` but in no `byUser` row, and that
 *     asymmetry is intended.
 *   - Every array is sorted by `sessionCount` descending, THEN by the row's own
 *     dimension key ascending (ISS-10851). The facet lists are read top-down
 *     and the order is part of what the surface publishes; without the
 *     tiebreak, two rows tied on count order however Postgres happened to
 *     emit them, which does not agree with the live Prisma `groupBy`'s order.
 *
 * A null facet VALUE is a different case from an unresolvable one, and the two
 * are handled differently on purpose. Null means the dimension genuinely had no
 * value — an unattributed repository, a session with no model recorded. Those
 * rows are dropped from breakdowns whose contract declares a non-nullable
 * identifier, because there is no honest key to publish them under.
 */

import type {
  AgentSessionHarnessBreakdown,
  AgentSessionUsageByUser,
} from "@repo/api/src/types/agent-session";
import type {
  AgentSessionModelFacetOption,
  AgentSessionProjectFacetOption,
} from "@repo/api/src/types/agent-session-facet-options";
import type { AgentSessionRepositoryBreakdown } from "@repo/api/src/types/agent-session-usage-breakdown";
import type { BasicUser } from "@repo/api/src/types/user";
import { displayUserName } from "@/lib/user-display-name";
import type { UsageSqlFacetCount } from "./usage-sql-reader";

/**
 * Highest session count first, the order every facet list publishes.
 *
 * ISS-10851: a session-count TIE resolves however Postgres happened to emit
 * the rows, which is not the same order the live Prisma `groupBy` happens to
 * emit them in — so every caller passes a tiebreak key matching its live
 * counterpart (`usage-facet-projections.ts`, `project-facet-options.ts`,
 * `buildModelFilterOptionsFromCounts`) exactly. Without one, ties are real
 * divergences the shadow differ reports on every comparison, not noise.
 *
 * The first key is REQUIRED so a projection added later cannot compile with no
 * tiebreak at all; further keys are for a facet whose leading key is not unique
 * per row, which only `projectByProject` is.
 */
function byDescendingSessions<T extends { sessionCount: number }>(
  rows: T[],
  tiebreakKey: (row: T) => string,
  ...furtherTiebreakKeys: ((row: T) => string)[]
): T[] {
  const keys = [tiebreakKey, ...furtherTiebreakKeys];
  return rows.sort((left, right) => {
    const byCount = right.sessionCount - left.sessionCount;
    if (byCount !== 0) {
      return byCount;
    }
    for (const key of keys) {
      const compared = key(left).localeCompare(key(right));
      if (compared !== 0) {
        return compared;
      }
    }
    return 0;
  });
}

function optionsFor(
  rows: readonly UsageSqlFacetCount[],
  dimension: UsageSqlFacetCount["dimension"]
): UsageSqlFacetCount[] {
  return rows.filter((row) => row.dimension === dimension);
}

/**
 * The Owner breakdown.
 *
 * `usersById` comes from `buildUsageOwnerMap`, which is reused rather than
 * reimplemented: it already drops null ids before querying, so an unowned
 * session cannot be attributed to someone else by a lookup that happened to
 * return a row for a null key.
 */
export function projectByUser(
  rows: readonly UsageSqlFacetCount[],
  usersById: ReadonlyMap<string, BasicUser>
): AgentSessionUsageByUser[] {
  const projected = optionsFor(rows, "owner").flatMap((row) => {
    const user = row.value ? usersById.get(row.value) : undefined;
    if (!user) {
      // Deleted owner, or a session that never had one. Omitted rather than
      // labelled — see the module header.
      return [];
    }
    return [
      {
        userId: user.id,
        userName: displayUserName(user),
        userEmail: user.email,
        userAvatarUrl: user.avatarUrl,
        sessionCount: row.sessionCount,
        inputTokens: row.inputTokens,
        outputTokens: row.outputTokens,
        cacheReadTokens: row.cacheReadTokens,
        cacheWriteTokens: row.cacheWriteTokens,
        estimatedCost: row.estimatedCost,
      },
    ];
  });
  // `userId`, not `userName` — matching `usage-facet-projections.ts`'s
  // `buildUsageByUser` (ISS-10851): display names collide, so only the row's
  // own unique key is a deterministic tiebreak.
  return byDescendingSessions(projected, (option) => option.userId);
}

/**
 * The Harness breakdown. `harness` is NOT NULL in the schema (it defaults to
 * `"unknown"`), so a null value here would mean the statement changed shape
 * rather than that the data is missing; the row is dropped either way, because
 * the contract's `harness` is non-nullable.
 */
export function projectByHarness(
  rows: readonly UsageSqlFacetCount[]
): AgentSessionHarnessBreakdown[] {
  const projected = optionsFor(rows, "harness").flatMap((row) =>
    row.value === null
      ? []
      : [
          {
            harness: row.value,
            sessionCount: row.sessionCount,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            cacheReadTokens: row.cacheReadTokens,
            cacheWriteTokens: row.cacheWriteTokens,
            estimatedCost: row.estimatedCost,
          },
        ]
  );
  // `harness` breaks ties, matching `usage-facet-projections.ts` (ISS-10851) —
  // it is the row's own dimension value, already unique per row.
  return byDescendingSessions(projected, (option) => option.harness);
}

/**
 * The Repository breakdown — the one that publishes `errorCount` and drops the
 * cache columns. The asymmetry is the contract's, not this module's.
 *
 * A null `repository_full_name` is common and meaningful (a session with no
 * repository attributed), but `AgentSessionRepositoryBreakdown.repositoryFullName`
 * is non-nullable, so those rows have no key to publish under and are dropped.
 * Their sessions remain in `totalSessions`.
 */
export function projectByRepository(
  rows: readonly UsageSqlFacetCount[]
): AgentSessionRepositoryBreakdown[] {
  const projected = optionsFor(rows, "repository").flatMap((row) =>
    row.value === null
      ? []
      : [
          {
            repositoryFullName: row.value,
            sessionCount: row.sessionCount,
            inputTokens: row.inputTokens,
            outputTokens: row.outputTokens,
            estimatedCost: row.estimatedCost,
            errorCount: row.errorCount,
          },
        ]
  );
  // `repositoryFullName` breaks ties, matching `usage-facet-projections.ts`
  // (ISS-10851) — it is the row's own dimension value, already unique per row.
  return byDescendingSessions(projected, (option) => option.repositoryFullName);
}

/**
 * The Model FACET options — count only, no sums.
 *
 * FEA-4303: these are grouped on `session_detail.model`, the primary displayed
 * model, so the facet can never offer a value the table's Model column cannot
 * show. That is deliberately NOT the same population as the cost lens `byModel`,
 * which spans every model a session used including subagent models. ISS-8554 O2
 * proposes dropping that lens entirely; this one stays either way.
 */
export function projectModelFilterOptions(
  rows: readonly UsageSqlFacetCount[]
): AgentSessionModelFacetOption[] {
  const projected = optionsFor(rows, "model").flatMap((row) =>
    row.value === null
      ? []
      : [{ model: row.value, sessionCount: row.sessionCount }]
  );
  // `model` breaks ties, matching the shared `buildModelFilterOptionsFromCounts`
  // (ISS-10851) both usage producers already use for the live path.
  return byDescendingSessions(projected, (option) => option.model);
}

/**
 * The Project facet options.
 *
 * Needs a name the session row does not carry, so unresolvable ids are dropped
 * for the same reason unresolvable owners are: a project id rendered as its own
 * label is not a name, and a placeholder is not an improvement over absence.
 */
export function projectByProject(
  rows: readonly UsageSqlFacetCount[],
  projectNamesById: ReadonlyMap<string, string>
): AgentSessionProjectFacetOption[] {
  const projected = optionsFor(rows, "project").flatMap((row) => {
    const projectName = row.value ? projectNamesById.get(row.value) : undefined;
    if (!(row.value && projectName)) {
      return [];
    }
    return [
      { projectId: row.value, projectName, sessionCount: row.sessionCount },
    ];
  });
  // `projectName` then `projectId`, matching `buildProjectFacetOptions`
  // (ISS-10851). Name alone is NOT total: `Project` carries only
  // `@@unique([organizationId, slug])`, so one org can hold two projects of the
  // same name, and a name-only tie falls back to input order — which is the
  // `UNION ALL` emission order here and the facet aggregate's unordered result
  // there, the exact divergence this file exists to close.
  return byDescendingSessions(
    projected,
    (option) => option.projectName,
    (option) => option.projectId
  );
}
