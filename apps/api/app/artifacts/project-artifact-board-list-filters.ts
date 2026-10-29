import "server-only";

import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import {
  type ProjectArtifactBoardFilters,
  ProjectArtifactBoardKind,
  type ProjectArtifactBoardKindStatus,
  ProjectArtifactBoardStatusMatch,
} from "@repo/api/src/types/project-artifact-board-page";
import { RELATED_SESSION_ELIGIBLE_KINDS } from "@repo/api/src/types/provenance-relationship";
import {
  ArtifactSubtype,
  ArtifactType,
  LinkType as DatabaseLinkType,
  Prisma,
} from "@repo/database";
import { eligibleEvidenceContributionsSql } from "@/app/agent-sessions/service/evidence-provenance";
import { classifiedSessionLinkCtes } from "@/app/agent-sessions/service/provenance-eligibility";
import {
  isAttributionEvidenceReadOnForOrganization,
  readAttributionEvidenceForRequest,
} from "@/lib/attribution-evidence-policy-feature";
import { toSqlContainsPattern } from "@/lib/sql-like";
import { userDisplayNameSql } from "./project-artifact-board-sort";

/**
 * ISS-12929: the portable project list's toolbar facets as board root
 * predicates. Unlike the project table's facets, every one of these applies
 * to every artifact kind, as the list's own predicate
 * (`useArtifactListShellDerived`) does: an untagged artifact fails a tag
 * filter, an artifact with no priority fails a priority filter, and the text
 * matches "<slug> <title>" for any kind.
 */
export function boardListToolbarFilterSql(
  filters: ProjectArtifactBoardFilters,
  scope: { organizationId: string; viewerUserId: string }
): Prisma.Sql {
  const { organizationId, viewerUserId } = scope;
  return Prisma.sql`${kindsSql(filters.kinds)}
      ${parentSql(filters.parentIds, organizationId)}
      ${relatedSessionsSql(filters.relatedSessionIds, organizationId)}
      ${customFieldValuesSql(filters.customFieldValues, organizationId)}
      ${customFieldRangesSql(filters.customFieldRanges, organizationId)}
      ${kindStatusesSql(filters.kindStatuses)}
      ${anyKindPrioritySql(filters.anyKindPriorities)}
      ${anyKindTagsSql(filters.anyKindTagIds)}
      ${mineOnlySql(filters.mineOnly, viewerUserId)}
      ${slugOrTitleSql(filters.slugOrTitle)}`;
}

const ISSUE_SUBTYPES_SQL = Prisma.join(
  [ArtifactSubtype.FEATURE, ArtifactSubtype.ISSUE].map(
    (subtype) => Prisma.sql`${subtype}`
  )
);

/**
 * `projectArtifactKind`: a FEATURE document is an Issue (the stored ISSUE
 * alias reads back as FEATURE), any other document is a Document, and the
 * other kinds are their artifact types.
 */
function kindSql(kind: ProjectArtifactBoardKind): Prisma.Sql {
  switch (kind) {
    case ProjectArtifactBoardKind.Issue:
      return Prisma.sql`(a.type = ${ArtifactType.DOCUMENT}::"ArtifactType" AND a.subtype::text IN (${ISSUE_SUBTYPES_SQL}))`;
    case ProjectArtifactBoardKind.Document:
      return Prisma.sql`(a.type = ${ArtifactType.DOCUMENT}::"ArtifactType" AND (a.subtype IS NULL OR a.subtype::text NOT IN (${ISSUE_SUBTYPES_SQL})))`;
    case ProjectArtifactBoardKind.Branch:
      return Prisma.sql`a.type = ${ArtifactType.BRANCH}::"ArtifactType"`;
    case ProjectArtifactBoardKind.Session:
      return Prisma.sql`a.type = ${ArtifactType.SESSION}::"ArtifactType"`;
    case ProjectArtifactBoardKind.Deployment:
      return Prisma.sql`a.type = ${ArtifactType.DEPLOYMENT}::"ArtifactType"`;
    default: {
      const exhaustive: never = kind;
      return exhaustive;
    }
  }
}

function kindsSql(kinds: ProjectArtifactBoardFilters["kinds"]) {
  if (!kinds || kinds.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND (${Prisma.join([...new Set(kinds)].map(kindSql), " OR ")})`;
}

/** One kind's statuses as its client-resolved membership test. */
function kindStatusSql(entry: ProjectArtifactBoardKindStatus): Prisma.Sql {
  const statuses = [...new Set(entry.statuses)].map(
    (status) => Prisma.sql`${status}`
  );
  if (entry.match === ProjectArtifactBoardStatusMatch.Only) {
    return statuses.length === 0
      ? Prisma.sql`false`
      : Prisma.sql`(${kindSql(entry.kind)} AND a.status IN (${Prisma.join(statuses)}))`;
  }
  return statuses.length === 0
    ? kindSql(entry.kind)
    : Prisma.sql`(${kindSql(entry.kind)} AND a.status NOT IN (${Prisma.join(statuses)}))`;
}

function kindStatusesSql(
  kindStatuses: ProjectArtifactBoardFilters["kindStatuses"]
) {
  if (kindStatuses === undefined) {
    return Prisma.empty;
  }
  if (kindStatuses.length === 0) {
    return Prisma.sql`AND false`;
  }
  return Prisma.sql`AND (${Prisma.join(kindStatuses.map(kindStatusSql), " OR ")})`;
}

function anyKindPrioritySql(
  priorities: ProjectArtifactBoardFilters["anyKindPriorities"]
) {
  if (!priorities || priorities.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND a.priority IN (${Prisma.join([...new Set(priorities)].map((priority) => Prisma.sql`${priority}::"Priority"`))})`;
}

function anyKindTagsSql(tagIds: readonly string[] | undefined) {
  if (!tagIds || tagIds.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND EXISTS (
        SELECT 1
        FROM tag_artifacts list_tag
        WHERE list_tag.artifact_id = a.id
          AND list_tag.tag_id IN (${Prisma.join([...new Set(tagIds)].map((id) => Prisma.sql`${id}::uuid`))})
      )`;
}

function mineOnlySql(mineOnly: boolean | undefined, viewerUserId: string) {
  return mineOnly === true
    ? Prisma.sql`AND a.assignee_id = ${viewerUserId}::uuid`
    : Prisma.empty;
}

function slugOrTitleSql(term: string | undefined) {
  const trimmed = term?.trim();
  if (!trimmed) {
    return Prisma.empty;
  }
  const pattern = toSqlContainsPattern(trimmed);
  return Prisma.sql`AND (COALESCE(a.slug, '') || ' ' || a.name) ILIKE ${pattern} ESCAPE '\\'`;
}

const uuidList = (ids: readonly string[]) =>
  Prisma.join([...new Set(ids)].map((id) => Prisma.sql`${id}::uuid`));

const textList = (values: readonly string[]) =>
  Prisma.join([...new Set(values)].map((value) => Prisma.sql`${value}`));

/**
 * The list's Parent column: a PRODUCES link from one of the selected
 * artifacts. A board root has no PRODUCES parent, so a parent selection keeps
 * no card, which is what the list keeps among its roots too.
 */
function parentSql(
  parentIds: readonly string[] | undefined,
  organizationId: string
) {
  if (!parentIds || parentIds.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND EXISTS (
        SELECT 1
        FROM artifact_links parent_filter
        WHERE parent_filter.target_id = a.id
          AND parent_filter.organization_id = ${organizationId}::uuid
          AND parent_filter.link_type = ${DatabaseLinkType.PRODUCES}::"LinkType"
          AND parent_filter.source_id IN (${uuidList(parentIds)})
      )`;
}

/**
 * The list's Related Sessions column: eligible evidence from one of the
 * selected sessions, read by the same SQL the Related Sessions read counts
 * with. The list never asks this of a session row, so sessions never match.
 *
 * ISS-12552 (PRD-800 "Rollout"): with `attribution-evidence-policy` on,
 * the cell counts operation evidence, so the filter reads it too; off, both
 * read the classified links. The answer is the one
 * {@link readBoardListFilterEvidence} read before the snapshot transaction.
 */
function relatedSessionsSql(
  sessionIds: readonly string[] | undefined,
  organizationId: string
) {
  if (!sessionIds || sessionIds.length === 0) {
    return Prisma.empty;
  }
  const selected = [...new Set(sessionIds)];
  if (isAttributionEvidenceReadOnForOrganization(organizationId)) {
    return Prisma.sql`AND a.type <> ${ArtifactType.SESSION}::"ArtifactType"
      AND EXISTS (
        SELECT 1 FROM (${eligibleEvidenceContributionsSql({
          organizationId,
          kinds: RELATED_SESSION_ELIGIBLE_KINDS,
          targetSql: (column) => Prisma.sql`${column} = a.id`,
          sessionArtifactIds: selected,
        })}) related_session
      )`;
  }
  return Prisma.sql`AND a.type <> ${ArtifactType.SESSION}::"ArtifactType"
      AND EXISTS (
        WITH ${classifiedSessionLinkCtes({
          organizationId,
          sessionArtifactIds: selected,
          targetSql: Prisma.sql`al.target_id = a.id`,
        })}
        SELECT 1 FROM classified_links WHERE kind IS NOT NULL
      )`;
}

const FIELD_VALUE_ROW_SQL = (organizationId: string, fieldId: string) =>
  Prisma.sql`field_value.organization_id = ${organizationId}::uuid
          AND field_value.entity_type::text = ${CustomFieldEntityType.Document}
          AND field_value.entity_id = a.id
          AND field_value.custom_field_id = ${fieldId}::uuid`;

/**
 * A document custom field holding one of the selected labels, each field type
 * labelled as the list labels it (`customFieldLabels`): the cached display
 * string for text, number and date, option names for enums, display names for
 * people, and target names for references.
 */
function customFieldValueSql(
  fieldId: string,
  labels: readonly string[],
  organizationId: string
) {
  const selected = textList(labels);
  return Prisma.sql`EXISTS (
        SELECT 1
        FROM custom_field_values field_value
        JOIN custom_fields field ON field.id = field_value.custom_field_id
        WHERE ${FIELD_VALUE_ROW_SQL(organizationId, fieldId)}
          AND CASE field.field_type::text
            WHEN ${CustomFieldType.Enum} THEN EXISTS (
              SELECT 1 FROM custom_field_enum_options option
              WHERE option.id = field_value.enum_value_id
                AND option.name IN (${selected})
            )
            WHEN ${CustomFieldType.MultiEnum} THEN EXISTS (
              SELECT 1 FROM custom_field_enum_options option
              WHERE option.id::text = ANY(field_value.multi_enum_value_ids)
                AND option.name IN (${selected})
            )
            WHEN ${CustomFieldType.People} THEN EXISTS (
              SELECT 1 FROM users person
              WHERE person.id::text = ANY(field_value.people_value_ids)
                AND ${userDisplayNameSql(Prisma.raw("person"))} IN (${selected})
            )
            WHEN ${CustomFieldType.Reference} THEN EXISTS (
              SELECT 1
              FROM custom_field_value_references reference
              JOIN artifacts target ON target.id = reference.target_artifact_id
              WHERE reference.custom_field_value_id = field_value.id
                AND target.name IN (${selected})
            )
            WHEN ${CustomFieldType.ReferenceMulti} THEN EXISTS (
              SELECT 1
              FROM custom_field_value_references reference
              JOIN artifacts target ON target.id = reference.target_artifact_id
              WHERE reference.custom_field_value_id = field_value.id
                AND target.name IN (${selected})
            )
            ELSE field_value.display_value IN (${selected})
          END
      )`;
}

function customFieldValuesSql(
  fields: ProjectArtifactBoardFilters["customFieldValues"],
  organizationId: string
) {
  const selected = (fields ?? []).filter((field) => field.labels.length > 0);
  if (selected.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND ${Prisma.join(
    selected.map((field) =>
      customFieldValueSql(field.fieldId, field.labels, organizationId)
    ),
    " AND "
  )}`;
}

/**
 * A number or date custom field outside the bounds removes the artifact; an
 * artifact with no such value stays, as the list's NaN comparison keeps it.
 */
function customFieldRangesSql(
  ranges: ProjectArtifactBoardFilters["customFieldRanges"],
  organizationId: string
) {
  const bounded = (ranges ?? []).filter(
    (range) => range.min !== undefined || range.max !== undefined
  );
  if (bounded.length === 0) {
    return Prisma.empty;
  }
  return Prisma.sql`AND ${Prisma.join(
    bounded.map((range) => {
      const value = Prisma.sql`COALESCE(field_value.number_value, EXTRACT(EPOCH FROM field_value.date_value) * 1000)`;
      const outside: Prisma.Sql[] = [];
      if (range.min !== undefined) {
        outside.push(Prisma.sql`${value} < ${range.min}`);
      }
      if (range.max !== undefined) {
        outside.push(Prisma.sql`${value} > ${range.max}`);
      }
      return Prisma.sql`NOT EXISTS (
        SELECT 1
        FROM custom_field_values field_value
        WHERE ${FIELD_VALUE_ROW_SQL(organizationId, range.fieldId)}
          AND (${Prisma.join(outside, " OR ")})
      )`;
    }),
    " AND "
  )}`;
}

/**
 * ISS-12552: the organization's `attribution-evidence-policy` answer for the
 * related sessions filter, read before the board opens its snapshot
 * transaction and only when the filter is set. Call it inside
 * `runWithAttributionEvidenceGate`.
 */
export async function readBoardListFilterEvidence(
  organizationId: string,
  filters: ProjectArtifactBoardFilters | undefined
): Promise<void> {
  if (filters?.relatedSessionIds && filters.relatedSessionIds.length > 0) {
    await readAttributionEvidenceForRequest(organizationId);
  }
}
