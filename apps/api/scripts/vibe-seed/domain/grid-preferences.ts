import {
  AgentComponentGroupBy,
  AgentComponentSortDir,
  AgentComponentSortKey,
  AgentMetricMode,
} from "@repo/api/src/types/agent-component";
import {
  BranchListSortDirection,
  BranchListSortKey,
} from "@repo/api/src/types/branch-list-contract";
import {
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceScopeKey,
  type GridPreferenceUpsertRequest,
} from "@repo/api/src/types/grid-preferences";
import { ProjectArtifactBoardGroup } from "@repo/api/src/types/project-artifact-board-page";
import {
  PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
  ProjectArtifactBoardLayout,
} from "@repo/api/src/types/project-artifact-board-view";
import { gridPreferenceService } from "@/app/settings/grid-preferences/grid-preference-service";
import { gridPreferenceUpsertRequestValidator } from "@/app/settings/grid-preferences/validators";
import type { VibeSeedContext } from "../stage";

/**
 * ISS-12017: one saved view per main grid for the local-trusted user, written
 * through `gridPreferenceService.upsertPreference` after the PUT route's own
 * validator. A grid that already has a stored view is left alone, so a re-run
 * neither duplicates nor bumps its revision.
 *
 * Column, sort and window ids are the registries' own: Sessions from
 * `packages/app/agents/lib/sessions-table-columns.ts`, `session-sort-group.ts`
 * and `session-grouping.ts`; Branches from `BRANCH_TOGGLEABLE_COLUMNS` and
 * `APPROVED_BRANCH_TOGGLEABLE_COLUMNS` (`packages/app/branches/hooks/use-branch-view-state.ts`);
 * Agents from `AGENT_COMPONENT_TOGGLEABLE_COLUMNS`
 * (`packages/app/agents/hooks/use-agent-components-view-state.ts`); the window
 * from `DateRange` (`packages/app/shared/lib/format-utils.ts`). `apps/api`
 * cannot import `@repo/app`, so those ids are spelled here.
 */

/** `DateRange.Last30Days`. */
const LAST_30_DAYS = "30d";
/** `SESSIONS_SAVED_VIEW_VERSION` and `SESSIONS_SAVED_VIEW_HIDDEN_VERSION`. */
const SESSIONS_SAVED_VIEW_VERSION = 1;
const SESSIONS_SAVED_VIEW_HIDDEN_VERSION = 3;
/** `AGENTS_SAVED_VIEW_VERSION`. */
const AGENTS_SAVED_VIEW_VERSION = 1;
const PAGE_SIZE = 50;

export const SEED_GRID_PREFERENCES: readonly GridPreferenceUpsertRequest[] = [
  {
    gridKey: GridPreferenceGridKey.Sessions,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Default,
    value: {
      sortKey: "cost",
      sortDir: "desc",
      secondarySorts: [{ fieldId: "lastActivity", direction: "desc" }],
      dateRange: LAST_30_DAYS,
      groupBy: "status",
      hiddenColumns: [
        "pr",
        "merge",
        "started",
        "updated",
        "projects",
        "issues",
        "model",
      ],
      columnOrder: [],
      columnWidths: {},
      hiddenSummaryCards: [],
      savedViewVersion: SESSIONS_SAVED_VIEW_VERSION,
      hiddenColumnsVersion: SESSIONS_SAVED_VIEW_HIDDEN_VERSION,
      pageSize: PAGE_SIZE,
    },
  },
  {
    gridKey: GridPreferenceGridKey.Branches,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Default,
    value: {
      sortKey: BranchListSortKey.Changes,
      sortDir: BranchListSortDirection.Desc,
      dateRange: LAST_30_DAYS,
      hiddenColumns: ["checks"],
      columnOrder: [
        "owner",
        "status",
        "pr",
        "changes",
        "sessions",
        "repo",
        "lastActivity",
        "checks",
      ],
      columnWidths: {},
      pageSize: PAGE_SIZE,
    },
  },
  {
    gridKey: GridPreferenceGridKey.Branches,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Approved,
    value: {
      sortKey: BranchListSortKey.Priority,
      sortDir: BranchListSortDirection.Asc,
      dateRange: LAST_30_DAYS,
      hiddenColumns: ["repo", "collaborators"],
      columnOrder: [],
      columnWidths: {},
    },
  },
  {
    gridKey: GridPreferenceGridKey.Agents,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Default,
    value: {
      sortKey: AgentComponentSortKey.Invocations,
      sortDir: AgentComponentSortDir.Desc,
      groupBy: AgentComponentGroupBy.Type,
      metricMode: AgentMetricMode.LocPerDollar,
      hiddenColumns: ["source"],
      columnOrder: [],
      columnWidths: {},
      savedViewVersion: AGENTS_SAVED_VIEW_VERSION,
    },
  },
  {
    gridKey: GridPreferenceGridKey.ProjectArtifacts,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Default,
    value: {
      arrangement: {
        cardFieldIds: ["priority", "owner", "tags", "updated"],
        collapsedLaneIds: [],
        laneField: ProjectArtifactBoardGroup.Status,
        laneOrder: [],
        layout: ProjectArtifactBoardLayout.List,
        manualOrder: true,
      },
      version: PROJECT_ARTIFACT_BOARD_VIEW_VERSION,
    },
  },
];

export async function seedGridPreferences(
  context: VibeSeedContext
): Promise<void> {
  let written = 0;
  for (const request of SEED_GRID_PREFERENCES) {
    const selector = {
      organizationId: context.organizationId,
      userId: context.userId,
      gridKey: request.gridKey,
      preferenceKind: request.preferenceKind,
      scopeKey: request.scopeKey,
    };
    if ((await gridPreferenceService.getPreference(selector)) !== null) {
      continue;
    }
    const parsed = gridPreferenceUpsertRequestValidator.parse(request);
    const result = await gridPreferenceService.upsertPreference({
      ...selector,
      value: parsed.value,
    });
    if (!result.ok) {
      throw new Error(
        `storing the ${request.gridKey}/${request.scopeKey} view conflicted at revision ${result.error.conflict.currentRevision ?? "unknown"}`
      );
    }
    written += 1;
  }
  context.log(`grid preferences: ${written} view(s) written`);
}
