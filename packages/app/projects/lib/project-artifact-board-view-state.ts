import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
  type ProjectArtifactBoardUrlAxes,
  type ProjectArtifactBoardView,
} from "@repo/api/src/types/project-artifact-board-view";
import { z } from "zod";

const boundedIds = z.array(z.string().min(1).max(128)).max(100);

const arrangementSchema = z
  .object({
    cardFieldIds: boundedIds,
    collapsedLaneIds: boundedIds,
    laneField: z.enum(ProjectArtifactBoardGroup),
    laneOrder: boundedIds,
    layout: z.enum(ProjectArtifactBoardLayout),
    manualOrder: z.boolean(),
    secondaryLaneField: z.enum(ProjectArtifactBoardGroup).optional(),
  })
  .strict();

const viewSchema = z
  .object({
    arrangement: arrangementSchema,
    version: z.literal(PROJECT_ARTIFACT_BOARD_VIEW_VERSION),
  })
  .strict();

const legacyListOnlySchema = z
  .object({
    columnIds: boundedIds.optional(),
    groupBy: z.enum(ProjectArtifactBoardGroup),
    layout: z.enum(ProjectArtifactBoardLayout),
    manualOrdering: z.boolean().optional(),
    secondaryGroupBy: z.enum(ProjectArtifactBoardGroup).optional(),
  })
  .strict();

/** Parse current and list-only predecessor views; unknown/newer shapes fail closed. */
export function parseProjectArtifactBoardView(
  input: unknown,
  fallback: ProjectArtifactBoardView
): ProjectArtifactBoardView {
  return decodeProjectArtifactBoardView(input, fallback) ?? fallback;
}

/** Decode compatible saved/preference state without fabricating a replacement. */
export function decodeProjectArtifactBoardView(
  input: unknown,
  fallback: ProjectArtifactBoardView
): ProjectArtifactBoardView | null {
  const current = viewSchema.safeParse(input);
  if (current.success) {
    return current.data;
  }
  const legacy = legacyListOnlySchema.safeParse(input);
  if (!legacy.success) {
    return null;
  }
  return {
    arrangement: {
      ...fallback.arrangement,
      cardFieldIds: legacy.data.columnIds ?? fallback.arrangement.cardFieldIds,
      laneField: legacy.data.groupBy,
      layout: legacy.data.layout,
      manualOrder:
        legacy.data.manualOrdering ?? fallback.arrangement.manualOrder,
      ...(legacy.data.secondaryGroupBy
        ? { secondaryLaneField: legacy.data.secondaryGroupBy }
        : {}),
    },
    version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  };
}

/** URL > saved view > persisted preference > defaults, independently per axis. */
export function resolveProjectArtifactBoardView(input: {
  defaults: ProjectArtifactBoardView;
  persisted?: ProjectArtifactBoardView | null;
  saved?: ProjectArtifactBoardView | null;
  url?: ProjectArtifactBoardUrlAxes & {
    secondaryLaneField?: ProjectArtifactBoardGroup | null;
  };
}): ProjectArtifactBoardView {
  const base =
    input.saved?.arrangement ??
    input.persisted?.arrangement ??
    input.defaults.arrangement;
  const url = input.url ?? {};
  const secondarySpecified = Object.hasOwn(url, "secondaryLaneField");
  const secondaryLaneField = secondarySpecified
    ? url.secondaryLaneField
    : base.secondaryLaneField;
  const {
    secondaryLaneField: _baseSecondaryLaneField,
    ...baseWithoutSecondary
  } = base;
  return {
    arrangement: {
      ...baseWithoutSecondary,
      ...(url.cardFieldIds ? { cardFieldIds: url.cardFieldIds } : {}),
      ...(url.collapsedLaneIds
        ? { collapsedLaneIds: url.collapsedLaneIds }
        : {}),
      ...(url.laneField ? { laneField: url.laneField } : {}),
      ...(url.layout ? { layout: url.layout } : {}),
      ...(secondaryLaneField ? { secondaryLaneField } : {}),
    },
    version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  };
}

/** Serialize with optional secondary field omitted rather than null. */
export function serializeProjectArtifactBoardView(
  view: ProjectArtifactBoardView
) {
  return JSON.stringify({
    arrangement: {
      ...view.arrangement,
      ...(view.arrangement.secondaryLaneField
        ? { secondaryLaneField: view.arrangement.secondaryLaneField }
        : {}),
    },
    version: view.version,
  });
}
