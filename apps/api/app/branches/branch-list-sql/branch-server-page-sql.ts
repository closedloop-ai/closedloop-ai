import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import {
  BranchListFilterFacet,
  type BranchServerPageQuery,
} from "@repo/api/src/types/branch-list-contract";
import type { BranchStatusOrdering } from "@repo/api/src/types/branch-status-order";
import { Prisma } from "@repo/database";
import type { BranchListOperationQuery } from "../branch-list-query";
import { branchListDimensionCteSql } from "./branch-list-dimension-sql";
import {
  branchListAllPassSql,
  branchListDateWindowSql,
  branchListFilterFlagsSql,
  branchListOrderBySql,
  branchListPassSql,
  branchListSearchSql,
} from "./branch-list-filter-sql";

/** The discriminator on the single result set the page read returns. */
export const BranchListSqlRowKind = {
  Page: "page",
  Total: "total",
  Retained: "retained",
  Offset: "offset",
  Facet: "facet",
  Availability: "availability",
} as const;
export type BranchListSqlRowKind =
  (typeof BranchListSqlRowKind)[keyof typeof BranchListSqlRowKind];

/** The availability tallies one facet's `identityFacetAvailability` fold needs. */
export const BranchListSqlAvailabilityMeasure = {
  Rows: "rows",
  NonComplete: "non_complete",
  Unavailable: "unavailable",
} as const;
export type BranchListSqlAvailabilityMeasure =
  (typeof BranchListSqlAvailabilityMeasure)[keyof typeof BranchListSqlAvailabilityMeasure];

export type BranchListSqlRow = {
  kind: BranchListSqlRowKind;
  facet: string | null;
  value: string | null;
  label: string | null;
  count: bigint | number | null;
  ord: bigint | number | null;
};

/**
 * The whole Branch list page — ordering, pagination and all eight
 * cross-filtered facet counts — in ONE statement over the eligible corpus.
 *
 * ISS-10298. The facets describe the corpus, the page names 25 ids, and only
 * those ids are hydrated and projected afterwards. The eight facets are counted
 * with their OWN predicate dropped and the other eight kept, which is what
 * `buildFacets` does by passing `omittedFacet` — get that wrong and every count
 * is plausibly off by a little.
 */
export function branchServerPageSql(
  organizationId: string,
  operationQuery: BranchListOperationQuery,
  query: BranchServerPageQuery,
  evaluationNow: Date,
  ordering: BranchStatusOrdering,
  identityResolved = true
): Prisma.Sql {
  return Prisma.sql`
    WITH dims AS (
      ${branchListDimensionCteSql(organizationId, operationQuery, evaluationNow, identityResolved, query)}
    ),
    flagged AS (
      SELECT
        dims.*,
        ${branchListFilterFlagsSql(query)}
      FROM dims
      WHERE ${branchListDateWindowSql(query)}
        AND ${branchListSearchSql(query)}
    ),
    cohort AS (
      SELECT
        flagged.id,
        flagged.last_active_at,
        row_number() OVER (ORDER BY ${branchListOrderBySql(query, ordering)}) AS rn
      FROM flagged
      WHERE ${branchListAllPassSql()}
    ),
    cohort_total AS (
      SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE cohort.last_active_at IS NULL)::int
          AS retained_unavailable
      FROM cohort
    ),
    page_window AS (
      SELECT
        cohort_total.total,
        cohort_total.retained_unavailable,
        ${branchListRepairedOffsetSql(query)} AS repaired_offset
      FROM cohort_total
    ),
    ${branchListFacetValuesCteSql()},
    ${branchListAvailabilityCteSql()}
    SELECT
      ${BranchListSqlRowKind.Page} AS kind,
      NULL AS facet,
      cohort.id::text AS value,
      NULL AS label,
      NULL::bigint AS count,
      cohort.rn AS ord
    FROM cohort
    CROSS JOIN page_window
    WHERE cohort.rn > page_window.repaired_offset
      AND cohort.rn <= page_window.repaired_offset + ${query.limit}
    UNION ALL
    SELECT ${BranchListSqlRowKind.Total}, NULL, NULL, NULL,
      page_window.total::bigint, NULL
    FROM page_window
    UNION ALL
    SELECT ${BranchListSqlRowKind.Retained}, NULL, NULL, NULL,
      page_window.retained_unavailable::bigint, NULL
    FROM page_window
    UNION ALL
    SELECT ${BranchListSqlRowKind.Offset}, NULL, NULL, NULL,
      page_window.repaired_offset::bigint, NULL
    FROM page_window
    UNION ALL
    SELECT
      ${BranchListSqlRowKind.Facet},
      facet_values.facet,
      facet_values.value,
      (array_agg(facet_values.label ORDER BY facet_values.row_ord))[1],
      COUNT(*) FILTER (WHERE facet_values.counted)::bigint,
      NULL
    FROM facet_values
    GROUP BY facet_values.facet, facet_values.value
    UNION ALL
    SELECT ${BranchListSqlRowKind.Availability}, facet_availability.facet,
      facet_availability.measure, NULL, facet_availability.count::bigint, NULL
    FROM facet_availability
  `;
}

/**
 * `repairOffset` (`packages/api/src/utils/math.ts`) as one expression, so the
 * slice and the `pageInfo.offset` the response states are the same number.
 * `branch-list-sql-parity.integration.test.ts` holds it to that helper's own
 * answer, including the offsets that repair to a non-zero last full page.
 */
function branchListRepairedOffsetSql(query: BranchServerPageQuery): Prisma.Sql {
  return Prisma.sql`CASE
    WHEN cohort_total.total = 0 THEN 0
    ELSE LEAST(
      ${query.offset},
      floor((cohort_total.total - 1) / ${query.limit})::int * ${query.limit}
    )
  END`;
}

/**
 * One row per (branch, facet, value) over the whole date-windowed corpus, with
 * `counted` marking the rows that survive the OTHER eight filters.
 *
 * `row_ord` is the candidate order the JavaScript fold sees, and it decides
 * which of several spellings of a label a facet option shows —
 * `collectLabels` keeps the FIRST label it meets for an id.
 */
function branchListFacetValuesCteSql(): Prisma.Sql {
  const arms = [
    branchListScalarFacetArmSql(
      "names",
      Prisma.sql`flagged.branch_name`,
      Prisma.sql`flagged.branch_name`,
      BranchListFilterFacet.Name
    ),
    branchListScalarFacetArmSql(
      "owners",
      Prisma.sql`flagged.owner_key`,
      Prisma.sql`flagged.owner_label`,
      BranchListFilterFacet.Owner
    ),
    branchListUnnestFacetArmSql(
      "collaborators",
      Prisma.sql`unnest(flagged.collaborator_keys, flagged.collaborator_labels)`,
      BranchListFilterFacet.Collaborators
    ),
    branchListScalarFacetArmSql(
      "statuses",
      Prisma.sql`flagged.status`,
      Prisma.sql`NULL`,
      BranchListFilterFacet.Status
    ),
    branchListScalarFacetArmSql(
      "pullRequests",
      Prisma.sql`flagged.pull_request_presence`,
      Prisma.sql`NULL`,
      BranchListFilterFacet.PullRequest
    ),
    branchListScalarFacetArmSql(
      "lastActiveRanges",
      Prisma.sql`flagged.last_active_range`,
      Prisma.sql`NULL`,
      BranchListFilterFacet.LastActive
    ),
    branchListScalarFacetArmSql(
      "repositories",
      Prisma.sql`flagged.repository`,
      Prisma.sql`flagged.repository`,
      BranchListFilterFacet.Repository
    ),
    branchListUnnestFacetArmSql(
      "tags",
      Prisma.sql`unnest(flagged.tag_ids, flagged.tag_names)`,
      BranchListFilterFacet.Tags
    ),
  ];
  return Prisma.sql`facet_values AS (
    ${Prisma.join(arms, "\n    UNION ALL\n    ")}
  )`;
}

function branchListScalarFacetArmSql(
  facet: string,
  value: Prisma.Sql,
  label: Prisma.Sql,
  omitted: BranchListFilterFacet
): Prisma.Sql {
  return Prisma.sql`SELECT
      ${facet} AS facet,
      ${value} AS value,
      ${label} AS label,
      flagged.row_ord AS row_ord,
      (${branchListPassSql(omitted)}) AS counted
    FROM flagged
    WHERE ${value} IS NOT NULL`;
}

function branchListUnnestFacetArmSql(
  facet: string,
  unnested: Prisma.Sql,
  omitted: BranchListFilterFacet
): Prisma.Sql {
  return Prisma.sql`SELECT
      ${facet} AS facet,
      exploded.value AS value,
      exploded.label AS label,
      flagged.row_ord AS row_ord,
      (${branchListPassSql(omitted)}) AS counted
    FROM flagged
    CROSS JOIN LATERAL ${unnested} AS exploded(value, label)
    WHERE exploded.value IS NOT NULL`;
}

/**
 * `identityFacetAvailability` and `tagFacetAvailability` both fold per-row
 * availability over the WHOLE date-windowed corpus, so the three tallies are
 * counted there rather than over a facet's counted population.
 */
function branchListAvailabilityCteSql(): Prisma.Sql {
  const arms = [
    branchListAvailabilityArmSql(
      "owners",
      Prisma.sql`flagged.owner_availability`
    ),
    branchListAvailabilityArmSql(
      "collaborators",
      Prisma.sql`flagged.collaborator_availability`
    ),
  ];
  return Prisma.sql`facet_availability AS (
    ${Prisma.join(arms, "\n    UNION ALL\n    ")}
  )`;
}

function branchListAvailabilityArmSql(
  facet: string,
  availability: Prisma.Sql
): Prisma.Sql {
  return Prisma.sql`SELECT
      ${facet} AS facet,
      measure.name AS measure,
      CASE measure.name
        WHEN ${BranchListSqlAvailabilityMeasure.Rows} THEN COUNT(*)
        WHEN ${BranchListSqlAvailabilityMeasure.NonComplete}
          THEN COUNT(*) FILTER (
            WHERE ${availability} IS DISTINCT FROM ${BranchIdentityAvailability.Complete}
          )
        ELSE COUNT(*) FILTER (
          WHERE ${availability} = ${BranchIdentityAvailability.Unavailable}
        )
      END AS count
    FROM flagged
    CROSS JOIN (
      VALUES (${BranchListSqlAvailabilityMeasure.Rows}),
        (${BranchListSqlAvailabilityMeasure.NonComplete}),
        (${BranchListSqlAvailabilityMeasure.Unavailable})
    ) AS measure(name)
    GROUP BY measure.name`;
}
