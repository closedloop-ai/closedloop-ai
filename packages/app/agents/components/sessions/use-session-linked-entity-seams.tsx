"use client";

import type {
  AgentSessionListItem,
  SessionLinkedArtifact,
} from "@repo/api/src/types/agent-session";
import type {
  SessionsSeamCellRenderer,
  SessionTableRow,
} from "@repo/app/agents/lib/session-list-row";
import {
  ArtifactProjectPresentation,
  ArtifactProjectValue,
} from "@repo/app/projects/components/artifact-project-value";
import { GridEmptyValue } from "@repo/design-system/components/ui/grid-table";
import { TicketIcon } from "lucide-react";
import { useMemo } from "react";
import {
  resolveSessionIssueChips,
  SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID,
  type SessionLinkedEntityChip,
} from "../../lib/session-linked-entity-chips";
import { SessionLinkedChipsCell } from "./session-linked-chips-cell";

/**
 * FEA-4209 / FEA-4210: the OWNING-PROJECT and linked-ISSUES cell seams, built
 * once for every host that renders them.
 *
 * Extracted from `SyncedSessionsTable` by ISS-7052 Part A, which gave the v2
 * Sessions surface a second host for the same two columns. Both columns are
 * cloud-only projections off the raw `AgentSession` — a `SessionTableRow` does
 * not carry them — so a host that cannot supply the raw records must not grow
 * the columns at all, and every host that can should render them identically.
 * Deriving per host is how the two would drift.
 *
 * The two are no longer the same SHAPE, which is why only one of them still
 * speaks in chips. Issues stay a chip list: a session links to many, and the
 * cell only reads them. Project is one field the viewer WRITES (ISS-12454), so
 * it mounts the shared `ArtifactProjectValue` the Details row mounts.
 *
 * `showLinkedEntityColumns` false returns `undefined` for both renderers, which
 * is the signal `SessionsTable` and `SessionsListSurfaceV2` both read as "this
 * mount cannot fill the column" — the column is dropped rather than rendered as
 * a track of em dashes. It is also what keeps the field off signed-out Desktop,
 * where there is no cloud record to re-file.
 */
export function useSessionLinkedEntitySeams({
  getIssueHref,
  itemById,
  rows,
  showLinkedEntityColumns,
}: {
  getIssueHref?: (artifact: SessionLinkedArtifact) => string | null;
  itemById: ReadonlyMap<string, AgentSessionListItem>;
  rows: readonly SessionTableRow[];
  showLinkedEntityColumns: boolean;
}): {
  renderProjects: SessionsSeamCellRenderer | undefined;
  renderIssues: SessionsSeamCellRenderer | undefined;
} {
  // Derived once per render rather than per cell: the seam has to hand the grid
  // the shared `GridEmptyValue` sentinel for a row with nothing to link, which
  // means knowing whether a row has chips BEFORE rendering its cell. Keyed by
  // row id and read from `itemById`, because the derivations need the raw
  // record, not the display-ready row.
  const issueChipsByRowId = useMemo(() => {
    const byRowId = new Map<string, readonly SessionLinkedEntityChip[]>();
    if (!showLinkedEntityColumns) {
      return byRowId;
    }
    for (const row of rows) {
      const item = itemById.get(row.id);
      if (!item) {
        continue;
      }
      byRowId.set(row.id, resolveSessionIssueChips(item, getIssueHref));
    }
    return byRowId;
  }, [rows, itemById, showLinkedEntityColumns, getIssueHref]);

  return useMemo(() => {
    if (!showLinkedEntityColumns) {
      return { renderProjects: undefined, renderIssues: undefined };
    }
    return {
      renderIssues: (row, { uncapped }) => {
        const chips = issueChipsByRowId.get(row.id);
        // The shared empty sentinel returned DIRECTLY, not a component that
        // renders one: the card fallback drops a field whose cell is empty and
        // decides that with `isEmptyCellValue`, which matches a `GridEmptyValue`
        // ELEMENT. Handing it a wrapper would leave every card with a dead field
        // on exactly the rows with nothing in it.
        if (!chips || chips.length === 0) {
          return <GridEmptyValue />;
        }
        return (
          <SessionLinkedChipsCell
            chips={chips}
            icon={<TicketIcon aria-hidden />}
            overflowNoun="issue"
            testId={SESSION_LINKED_ISSUES_OVERFLOW_TEST_ID}
            uncapped={uncapped}
          />
        );
      },
      // ISS-12454, operator ruling 2026-10-13 ("Project should be editable on
      // list surfaces"): the same control the Details row mounts, so the field
      // keeps ONE writer (`POST /artifact-links/batch-move`) rather than gaining
      // a list-only second one. It decides read-only itself when there is no API
      // port or query client, which is what keeps a Storybook or mini-table
      // mount rendering the name alone.
      //
      // An unfiled session therefore gets a PICKER here, not the empty sentinel
      // the chip cell returned — filing one is what the control exists for, the
      // same reason the Details row declares itself never-empty. A row with no
      // raw record still returns the sentinel directly, because that cell has
      // nothing to write against and the card fallback drops a field by matching
      // a `GridEmptyValue` ELEMENT.
      renderProjects: (row, { uncapped }) => {
        const item = itemById.get(row.id);
        if (!item) {
          return <GridEmptyValue />;
        }
        return (
          <ArtifactProjectValue
            artifactId={item.id}
            // `uncapped` is the card path, where the list IS cards and the input
            // is a thumb — the grid cell's collapsed trigger is not a touch
            // target. The chips cell split on this same signal for the same
            // reason, so discarding it here would have been the one thing this
            // seam exists to carry.
            presentation={
              uncapped
                ? ArtifactProjectPresentation.Card
                : ArtifactProjectPresentation.Cell
            }
            projectId={item.project?.id ?? null}
            projectName={item.project?.name ?? null}
          />
        );
      },
    };
  }, [issueChipsByRowId, itemById, showLinkedEntityColumns]);
}
