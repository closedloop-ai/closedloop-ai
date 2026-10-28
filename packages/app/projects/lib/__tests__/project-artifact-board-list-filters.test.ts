import { ArtifactDateField } from "@repo/api/src/types/artifact-date-filter";
import { ARTIFACT_STATUS_ROOT } from "@repo/api/src/types/artifact-status";
import { BranchStatus } from "@repo/api/src/types/branch";
import { Priority } from "@repo/api/src/types/common";
import { DocumentStatus, IssueStatus } from "@repo/api/src/types/document";
import {
  PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER,
  ProjectArtifactBoardKind,
  ProjectArtifactBoardStatusMatch,
} from "@repo/api/src/types/project-artifact-board-page";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { documentCustomFieldColumnId } from "@repo/app/documents/components/documents-prototype-custom-fields";
import {
  GenericArtifactKind,
  GenericArtifactStatus,
  genericArtifactStatusFromRaw,
  genericArtifactStatusKey,
  genericArtifactStatusMatchesAny,
  genericArtifactStatusOptions,
} from "@repo/app/shared/components/generic-artifact-surface/generic-artifact-status";
import {
  initialArtifactFilters,
  RELATED_SESSIONS_COLUMN_ID,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/artifact-list-model";
import { UNASSIGNED_ASSIGNEE_LABEL } from "@repo/app/shared/lib/user-utils";
import { TableDatePreset } from "@repo/design-system/components/ui/table-filters-v2";
import { describe, expect, it } from "vitest";
import {
  boardKindStatuses,
  PROJECT_LIST_PARENT_COLUMN_ID,
  PROJECT_LIST_PRIORITY_COLUMN_ID,
  type ProjectBoardListToolbar,
  projectBoardListFilters,
} from "../project-artifact-board-list-filters";

const NOW = new Date("2026-10-22T12:00:00.000Z");

const TOOLBAR: ProjectBoardListToolbar = {
  customFieldRangeColumnIds: new Set(),
  dateDimension: { present: false },
  extensionFilters: {},
  filters: initialArtifactFilters,
  search: "",
};

const BOARD_KIND_BY_GENERIC: Partial<
  Record<GenericArtifactKind, ProjectArtifactBoardKind>
> = {
  [GenericArtifactKind.Branch]: ProjectArtifactBoardKind.Branch,
  [GenericArtifactKind.Deployment]: ProjectArtifactBoardKind.Deployment,
  [GenericArtifactKind.Document]: ProjectArtifactBoardKind.Document,
  [GenericArtifactKind.Issue]: ProjectArtifactBoardKind.Issue,
  [GenericArtifactKind.Session]: ProjectArtifactBoardKind.Session,
};

/** Stored statuses per kind, plus off-vocabulary ones a row can still hold. */
const RAW_SAMPLES: Record<ProjectArtifactBoardKind, readonly string[]> = {
  [ProjectArtifactBoardKind.Branch]: [...Object.values(BranchStatus), "WEIRD"],
  [ProjectArtifactBoardKind.Deployment]: ["READY", "ERROR"],
  [ProjectArtifactBoardKind.Document]: [
    ...Object.values(DocumentStatus),
    IssueStatus.Todo,
    "WEIRD",
  ],
  [ProjectArtifactBoardKind.Issue]: [
    ...Object.values(IssueStatus),
    DocumentStatus.Draft,
    "WEIRD",
  ],
  [ProjectArtifactBoardKind.Session]: [
    ...Object.values(SESSION_STATUS),
    "waiting",
    "WEIRD",
  ],
};

/** Every key the status facet can hold: roots, details and a legacy word. */
const STATUS_KEYS = [
  ...new Set([
    ...Object.values(ARTIFACT_STATUS_ROOT),
    "unknown",
    "legacy-preview:Todo",
    ...Object.values(GenericArtifactKind).flatMap((kind) =>
      genericArtifactStatusOptions(kind).map((status) =>
        genericArtifactStatusKey({ kind, status })
      )
    ),
  ]),
];

describe("ISS-12929 portable board status facet", () => {
  for (const key of STATUS_KEYS) {
    it(`keeps on the server exactly the rows the list keeps for ${key}`, () => {
      const entries = boardKindStatuses([key]);
      for (const [genericKind, boardKind] of Object.entries(
        BOARD_KIND_BY_GENERIC
      ) as [GenericArtifactKind, ProjectArtifactBoardKind][]) {
        const entry = entries.find((candidate) => candidate.kind === boardKind);
        for (const raw of RAW_SAMPLES[boardKind]) {
          const listKeeps = genericArtifactStatusMatchesAny(
            {
              kind: genericKind,
              status:
                genericArtifactStatusFromRaw(genericKind, raw) ??
                GenericArtifactStatus.Todo,
              statusRaw: raw,
            },
            [key]
          );
          let serverKeeps = false;
          if (entry?.match === ProjectArtifactBoardStatusMatch.Only) {
            serverKeeps = entry.statuses.includes(raw);
          } else if (entry?.match === ProjectArtifactBoardStatusMatch.Except) {
            serverKeeps = !entry.statuses.includes(raw);
          }
          expect(serverKeeps, `${boardKind} ${raw}`).toBe(listKeeps);
        }
      }
    });
  }
});

describe("ISS-12929 portable board toolbar filters", () => {
  it("narrows nothing when the toolbar is clear", () => {
    expect(projectBoardListFilters(TOOLBAR, NOW)).toBeUndefined();
  });

  it("carries each toolbar facet in the list's own meaning", () => {
    expect(
      projectBoardListFilters(
        {
          customFieldRangeColumnIds: new Set(),
          dateDimension: { present: true, range: "30d", setRange: () => {} },
          extensionFilters: {
            [PROJECT_LIST_PRIORITY_COLUMN_ID]: {
              selectedValues: [Priority.High],
            },
          },
          filters: {
            ...initialArtifactFilters,
            favoritesOnly: true,
            kinds: [GenericArtifactKind.Issue, GenericArtifactKind.Session],
            mineOnly: true,
            owners: ["user-1", UNASSIGNED_ASSIGNEE_LABEL],
            tags: ["tag-1"],
            updatedPreset: TableDatePreset.Last7d,
          },
          search: "  apollo ",
        },
        NOW
      )
    ).toEqual({
      anyKindPriorities: [Priority.High],
      anyKindTagIds: ["tag-1"],
      assigneeIds: ["user-1", PROJECT_ARTIFACT_BOARD_UNASSIGNED_FILTER],
      // The stricter of the Updated filter and the range control.
      dateWindow: {
        field: ArtifactDateField.UpdatedAt,
        from: new Date("2026-10-15T12:00:00.000Z"),
        to: NOW,
      },
      favoritesOnly: true,
      kinds: [ProjectArtifactBoardKind.Issue, ProjectArtifactBoardKind.Session],
      mineOnly: true,
      slugOrTitle: "apollo",
    });
  });

  it("carries the Parent, Related Sessions and custom-field column filters", () => {
    const rangeColumn = documentCustomFieldColumnId("field-estimate");
    expect(
      projectBoardListFilters(
        {
          ...TOOLBAR,
          customFieldRangeColumnIds: new Set([rangeColumn]),
          extensionFilters: {
            [documentCustomFieldColumnId("field-stage")]: {
              selectedValues: ["Beta"],
            },
            [PROJECT_LIST_PARENT_COLUMN_ID]: { selectedValues: ["parent-1"] },
            [RELATED_SESSIONS_COLUMN_ID]: { selectedValues: ["session-1"] },
            // A range column reads its bounds only, as the list does.
            [rangeColumn]: { max: 5, selectedValues: ["8"] },
          },
        },
        NOW
      )
    ).toEqual({
      customFieldRanges: [{ fieldId: "field-estimate", max: 5 }],
      customFieldValues: [{ fieldId: "field-stage", labels: ["Beta"] }],
      parentIds: ["parent-1"],
      relatedSessionIds: ["session-1"],
    });
  });

  it("keeps nothing for a kind selection the board cannot express", () => {
    expect(
      projectBoardListFilters(
        {
          ...TOOLBAR,
          filters: {
            ...initialArtifactFilters,
            kinds: [GenericArtifactKind.Agent],
          },
        },
        NOW
      )
    ).toEqual({ kindStatuses: [] });
  });
});
