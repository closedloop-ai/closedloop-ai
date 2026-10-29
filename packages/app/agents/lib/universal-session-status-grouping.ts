import { ARTIFACT_STATUS_DETAIL } from "@repo/api/src/types/artifact-status";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { SessionTableRow } from "@repo/app/agents/lib/session-list-row";
import { artifactStatusLabel } from "@repo/app/shared/components/artifact-status/artifact-status-presentation";
import { sessionStatusFacet } from "@repo/app/shared/lib/artifact-status-adapter";
import { groupRowEntries } from "@repo/app/shared/lib/table-grouping";

export type UniversalSessionStatusBand = {
  droppable: boolean;
  items: [SessionTableRow, ...SessionTableRow[]];
  key: string;
  label: string;
  value?: string;
};

/** Partitions Session rows by the canonical facet the champion actually renders. */
export function buildUniversalSessionStatusBands(
  rows: readonly SessionTableRow[]
): UniversalSessionStatusBand[] {
  return groupRowEntries(
    rows,
    (row) => {
      const facet = sessionStatusFacet(row.status, row.rawStatus);
      return {
        key: `${facet.normalized.root}:${facet.normalized.detail ?? ""}`,
        label: artifactStatusLabel(facet),
        value: canonicalStatusValue(facet.normalized.detail),
      };
    },
    ({ key, label, value }, row): UniversalSessionStatusBand => ({
      droppable: value !== undefined,
      items: [row],
      key,
      label,
      ...(value === undefined ? {} : { value }),
    })
  ).map(([, band]) => band);
}

function canonicalStatusValue(detail: string | undefined): string | undefined {
  switch (detail) {
    case ARTIFACT_STATUS_DETAIL.SessionRunning:
      return SESSION_STATUS.ACTIVE;
    case ARTIFACT_STATUS_DETAIL.SessionCompleted:
      return SESSION_STATUS.INACTIVE;
    case ARTIFACT_STATUS_DETAIL.SessionFailed:
      return SESSION_STATUS.ERROR;
    default:
      return undefined;
  }
}
