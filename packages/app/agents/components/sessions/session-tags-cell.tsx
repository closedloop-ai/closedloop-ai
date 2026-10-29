"use client";

import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  ArtifactTagAvailability,
  TagEntityType,
} from "@repo/api/src/types/tag";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { EntityTagsCell } from "../../../tags/components/entity-tags-cell";

/**
 * ISS-8712: the Sessions list's `Tags` cell — the ORG TAG VOCABULARY applied to
 * this row's Session artifact, through the same picker a PRD, an Issue, or a
 * Branch uses.
 *
 * A session's row `id` IS its Artifact id (`toSessionListItem` returns
 * `record.artifactId`), and `ArtifactType` already includes `SESSION`, so the
 * write is the existing `POST /entity-tags { entityType: ARTIFACT }` with no
 * new endpoint, join table, or enum member behind it.
 *
 * Lives here, as ONE cell both Sessions hosts mount, rather than in each host:
 * two copies would be two chances for the entity type, the id, or the
 * unavailable branch below to drift apart.
 *
 * ISS-9215 reduced it to that unavailable branch plus a row-shape mapping: the
 * chips, the trigger, and the read-only fallback are `EntityTagsCell`, shared
 * with Branches and Documents.
 */
export function SessionTagsCell({
  row,
  showUnavailable = true,
}: Readonly<{ row: SessionTableRow; showUnavailable?: boolean }>) {
  // Availability and the array are read TOGETHER. A producer that never loaded
  // the relation sends no `tags` and no `Available`, and rendering the picker's
  // empty state for it would state "this session has no tags" — a claim this
  // process never obtained. The em-dash is the same shared glyph every other
  // unknown cell in this table renders.
  if (row.tagAvailability !== ArtifactTagAvailability.Available) {
    return showUnavailable ? <GridEmptyValue /> : null;
  }

  return (
    <EntityTagsCell
      // Absent permissions mean the producer did not report them, which is not
      // a grant: the cell degrades to read-only chips. The API is the real
      // boundary either way — `/entity-tags` re-checks scope and org ownership
      // on every write — so this only decides which affordances are offered.
      canApply={row.tagPermissions?.canApply ?? false}
      canRemove={row.tagPermissions?.canRemove ?? false}
      // Naming the trigger after the session tells a screen-reader user WHICH
      // row's tags this opens, in a table of otherwise identical buttons.
      editLabel={`Edit tags for ${row.name}`}
      entityId={row.id}
      entityType={TagEntityType.Artifact}
      surface={ArtifactStatusEditSurface.InlineCell}
      tags={row.tags ?? []}
    />
  );
}

/**
 * The `renderTags` seam value, so each host wires the same cell by name instead
 * of repeating the closure that builds it.
 */
export function renderSessionTagsCell(row: SessionTableRow) {
  return <SessionTagsCell row={row} />;
}
