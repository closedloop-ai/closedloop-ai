import {
  AGENT_SESSION_ROW_FIELD_EDIT,
  AgentSessionPatchField,
  type AgentSessionRowField,
  ArtifactRowFieldEdit,
  BRANCH_ROW_FIELD_EDIT,
  BranchPatchField,
} from "@repo/api/src/types/artifact-row-field-edit";
// The wire type this file pins the grid against is `packages/api/src/types/branch.ts`'s
// `BranchRow` (the list wire shape), never the presentational `BranchRow` the
// Branches slice renders from (`packages/app/branches/lib/branch-row.ts`) — the
// two share a name and are otherwise unrelated types.
import type { BranchRow } from "@repo/api/src/types/branch";
// Cross-slice: the Sessions grid's own column declaration is the only evidence
// of which Session wire fields ISS-9485's registry (read by ISS-9484) has to
// classify; it is pinned beside the Branches grid because both read one module.
import {
  SESSIONS_AUTONOMY_COLUMN_ID,
  SESSIONS_BRANCHES_COLUMN_ID,
  SESSIONS_COLUMN_SPECS,
  SESSIONS_COST_COLUMN_ID,
  SESSIONS_HARNESS_COLUMN_ID,
  SESSIONS_ISSUES_COLUMN_ID,
  SESSIONS_MERGE_COLUMN_ID,
  SESSIONS_MODEL_COLUMN_ID,
  SESSIONS_OWNER_COLUMN_ID,
  SESSIONS_PR_COLUMN_ID,
  SESSIONS_PRIORITY_COLUMN_ID,
  SESSIONS_PROJECTS_COLUMN_ID,
  SESSIONS_REPO_COLUMN_ID,
  SESSIONS_STATUS_COLUMN_ID,
  SESSIONS_TAGS_COLUMN_ID,
  SESSIONS_UPDATED_COLUMN_ID,
} from "@repo/app/agents/lib/sessions-table-columns";
import { APPROVED_BRANCH_COLUMN_SPECS } from "@repo/app/branches/components/approved-branches-grid-adapter";
import {
  BRANCH_NAME_COLUMN_ID,
  BRANCH_PRIORITY_COLUMN_ID,
  BRANCH_PROJECT_COLUMN_ID,
  BRANCH_SESSIONS_COLUMN_ID,
} from "@repo/app/branches/lib/branch-column-view-model";
import { describe, expect, it } from "vitest";

/**
 * ISS-9485 — grid -> wire -> registry parity for the two row-field-edit
 * registries `AGENT_SESSION_ROW_FIELD_EDIT` and `BRANCH_ROW_FIELD_EDIT`
 * (`packages/api/src/types/artifact-row-field-edit.ts`).
 *
 * The registries are exhaustive over their WIRE row types, so `tsc` already
 * catches a wire field the registry forgets to classify. What it cannot catch
 * is a GRID column that renders a wire field without anyone deciding whether
 * that field is PATCH-able — a column added to `SESSIONS_COLUMN_SPECS` or
 * `APPROVED_BRANCH_COLUMN_SPECS` that the registry never hears about. This
 * file is the missing link: it names, per column, the wire field(s) the cell
 * actually reads, and holds that map to both the grid's own id set (so a new
 * column fails) and the registry's classification (so an editor cell can only
 * be wired to a field the registry actually calls PATCH-able).
 */

/**
 * Every Sessions DATA column's id, mapped to the `AgentSessionListItem` wire
 * field(s) its cell renders. Sourced from `session-cell-renderers.tsx` (the
 * `SESSION_FIELD_ADAPTERS` registry) for the columns it owns, and from the host seam
 * implementations (`use-session-linked-entity-seams.tsx`,
 * `session-detail-table.tsx`'s `renderCellForCard`/`renderCellForGrid`) for the four
 * columns a host supplies: Priority, Tags, Owning project, Linked issues.
 *
 * `duration` reads `startedAt` and `endedAt` (`session-table-row.ts`'s
 * `resolveSessionDurationWindow`/`resolveSessionWallClockMs`), not the wire
 * `wallClock` the collector reports — ISS-5131 stopped trusting that value.
 */
const SESSIONS_COLUMN_WIRE_FIELDS: Readonly<
  Record<string, readonly AgentSessionRowField[]>
> = {
  [SESSIONS_STATUS_COLUMN_ID]: ["status"],
  [SESSIONS_PRIORITY_COLUMN_ID]: ["priority"],
  [SESSIONS_TAGS_COLUMN_ID]: ["tags"],
  // ISS-12251 D-1. `user` is read too, only from a producer that omits
  // `assignee` (AC-012), and the registry classifies it NotUserOwned.
  [SESSIONS_OWNER_COLUMN_ID]: ["assignee"],
  [SESSIONS_AUTONOMY_COLUMN_ID]: ["autonomy"],
  [SESSIONS_PROJECTS_COLUMN_ID]: ["project"],
  [SESSIONS_REPO_COLUMN_ID]: ["repositoryFullName", "repo"],
  [SESSIONS_BRANCHES_COLUMN_ID]: ["branch"],
  [SESSIONS_ISSUES_COLUMN_ID]: ["linkedArtifacts"],
  [SESSIONS_HARNESS_COLUMN_ID]: ["harness"],
  [SESSIONS_MODEL_COLUMN_ID]: ["model"],
  duration: ["startedAt", "endedAt"],
  [SESSIONS_COST_COLUMN_ID]: ["estimatedCost"],
  started: ["startedAt"],
  [SESSIONS_UPDATED_COLUMN_ID]: ["recordUpdatedAt"],
  lastActivity: ["lastActivityAt"],
  [SESSIONS_PR_COLUMN_ID]: ["prs"],
  [SESSIONS_MERGE_COLUMN_ID]: ["prsMerged"],
};

/**
 * The Sessions lead (Session Name) column. Not a member of
 * `SESSIONS_COLUMN_SPECS` — it is the grid's `SESSIONS_LEAD_GRID_TRACK`, always
 * rendered via `renderName` rather than a spec id — so it is pinned here
 * separately rather than folded into the id-parity assertion below, which
 * would otherwise demand a spec entry that does not exist.
 */
const SESSIONS_NAME_LEAD_WIRE_FIELDS: readonly AgentSessionRowField[] = [
  "name",
];

/**
 * Every Branches DATA column's id, mapped to the wire `BranchRow` field(s) its
 * cell renders. Sourced from `renderApprovedBranchCell`
 * (`approved-branches-grid-adapter.tsx`) and, where the app-side presentational
 * `BranchRow` (`branch-row.ts`) renames a field, from `branch-row-adapter.ts`'s
 * mapping back to the wire name — `repo` (app) <- `repoFullName` (wire), and
 * `prRepo` (app) is DERIVED from `repoFullName`, not its own wire field.
 */
const BRANCH_COLUMN_WIRE_FIELDS: Readonly<
  Record<string, readonly (keyof BranchRow)[]>
> = {
  owner: ["owner"],
  [BRANCH_PRIORITY_COLUMN_ID]: ["priority"],
  collaborators: ["collaborators"],
  [BRANCH_SESSIONS_COLUMN_ID]: ["sessionIds"],
  changes: ["additions", "deletions"],
  status: ["status"],
  pr: ["prNumber", "prTitle", "prUrl", "prState"],
  lastActivity: ["lastActivityAt"],
  repo: ["repoFullName"],
  tags: ["tags"],
  [BRANCH_PROJECT_COLUMN_ID]: ["projectId", "projectName"],
};

/**
 * The Branches lead (Name) column. Unlike Sessions, `BRANCH_NAME_COLUMN_ID` is
 * a real member of `BRANCH_COLUMN_VIEW_MODEL`, but `APPROVED_BRANCH_COLUMN_SPECS`
 * — the DATA columns a registry is built from — deliberately excludes it (its
 * own type says so: `Exclude<BranchColumnViewModelId, typeof
 * BRANCH_NAME_COLUMN_ID>`), so it is pinned separately here for the same reason
 * the Sessions lead is.
 */
const BRANCH_NAME_LEAD_WIRE_FIELDS: readonly (keyof BranchRow)[] = [
  "branchName",
];

/** Every value a row-field-edit registry may carry, keyed by patch-body key. */
const AGENT_SESSION_PATCH_FIELD_VALUES = new Set<string>(
  Object.values(AgentSessionPatchField)
);
const BRANCH_PATCH_FIELD_VALUES = new Set<string>(
  Object.values(BranchPatchField)
);

/**
 * Columns whose wire field the single-row PATCH writes. This pins the
 * registry, not the cells: only Priority is an inline editor today. Owner's
 * `assignee` is written through the API only; no surface offers it (ISS-12251
 * D-3).
 */
const SESSIONS_PATCHABLE_COLUMNS: Readonly<
  Record<string, AgentSessionPatchField>
> = {
  [SESSIONS_STATUS_COLUMN_ID]: AgentSessionPatchField.Status,
  [SESSIONS_OWNER_COLUMN_ID]: AgentSessionPatchField.OwnerUserId,
  [SESSIONS_PRIORITY_COLUMN_ID]: AgentSessionPatchField.Priority,
  [SESSIONS_PROJECTS_COLUMN_ID]: AgentSessionPatchField.ProjectId,
};
const BRANCH_PATCHABLE_COLUMNS: Readonly<Record<string, BranchPatchField>> = {
  [BRANCH_PRIORITY_COLUMN_ID]: BranchPatchField.Priority,
};

describe("Sessions grid -> wire -> row-field-edit registry parity", () => {
  it("names every SESSIONS_COLUMN_SPECS id, and only those ids", () => {
    const specIds = SESSIONS_COLUMN_SPECS.map((spec) => spec.id).sort();
    const tableIds = Object.keys(SESSIONS_COLUMN_WIRE_FIELDS).sort();
    expect(tableIds).toEqual(specIds);
  });

  it("maps every column's wire field(s) to a key the registry classifies", () => {
    for (const fields of Object.values(SESSIONS_COLUMN_WIRE_FIELDS)) {
      for (const field of fields) {
        expect(Object.hasOwn(AGENT_SESSION_ROW_FIELD_EDIT, field)).toBe(true);
      }
    }
    for (const field of SESSIONS_NAME_LEAD_WIRE_FIELDS) {
      expect(Object.hasOwn(AGENT_SESSION_ROW_FIELD_EDIT, field)).toBe(true);
    }
  });

  it("classifies the lead Session Name column as the PATCH-able Name field", () => {
    for (const field of SESSIONS_NAME_LEAD_WIRE_FIELDS) {
      expect(AGENT_SESSION_ROW_FIELD_EDIT[field]).toBe(
        AgentSessionPatchField.Name
      );
    }
  });

  it("classifies the PATCH-writable columns as their expected PATCH field", () => {
    for (const [columnId, expectedField] of Object.entries(
      SESSIONS_PATCHABLE_COLUMNS
    )) {
      const fields = SESSIONS_COLUMN_WIRE_FIELDS[columnId];
      expect(fields, `column ${columnId}`).toBeDefined();
      for (const field of fields ?? []) {
        expect(
          AGENT_SESSION_ROW_FIELD_EDIT[field],
          `column ${columnId} field ${field}`
        ).toBe(expectedField);
      }
    }
  });

  it("classifies the Tags column as own_route", () => {
    for (const field of SESSIONS_COLUMN_WIRE_FIELDS[SESSIONS_TAGS_COLUMN_ID] ??
      []) {
      expect(AGENT_SESSION_ROW_FIELD_EDIT[field]).toBe(
        ArtifactRowFieldEdit.OwnRoute
      );
    }
  });

  it("classifies every other column as a non-PATCH class", () => {
    const patchableColumnIds = new Set(Object.keys(SESSIONS_PATCHABLE_COLUMNS));
    for (const [columnId, fields] of Object.entries(
      SESSIONS_COLUMN_WIRE_FIELDS
    )) {
      if (patchableColumnIds.has(columnId)) {
        continue;
      }
      for (const field of fields) {
        const classification = AGENT_SESSION_ROW_FIELD_EDIT[field];
        expect(
          AGENT_SESSION_PATCH_FIELD_VALUES.has(classification),
          `column ${columnId} field ${field} resolved to a PATCH field (${classification})`
        ).toBe(false);
      }
    }
  });
});

describe("Branches grid -> wire -> row-field-edit registry parity", () => {
  it("names every APPROVED_BRANCH_COLUMN_SPECS id, and only those ids", () => {
    const specIds = APPROVED_BRANCH_COLUMN_SPECS.map((spec) => spec.id).sort();
    const tableIds = Object.keys(BRANCH_COLUMN_WIRE_FIELDS).sort();
    expect(tableIds).toEqual(specIds);
    // The lead column is deliberately absent from both: `ApprovedBranchColumnGeometry`
    // excludes it by type (`Exclude<BranchColumnViewModelId, typeof
    // BRANCH_NAME_COLUMN_ID>`), which is why it is pinned separately below rather
    // than folded into this id-equality set.
    expect(specIds).not.toContain(BRANCH_NAME_COLUMN_ID);
  });

  it("maps every column's wire field(s) to a key the registry classifies", () => {
    for (const fields of Object.values(BRANCH_COLUMN_WIRE_FIELDS)) {
      for (const field of fields) {
        expect(Object.hasOwn(BRANCH_ROW_FIELD_EDIT, field)).toBe(true);
      }
    }
    for (const field of BRANCH_NAME_LEAD_WIRE_FIELDS) {
      expect(Object.hasOwn(BRANCH_ROW_FIELD_EDIT, field)).toBe(true);
    }
  });

  it("does not classify the lead Name column as PATCH-able", () => {
    // Unlike Sessions, no host renders an inline editor over the Branches lead
    // column today — `renderApprovedBranchLead` is a plain link, never
    // `ArtifactPriorityEditor` or an equivalent.
    for (const field of BRANCH_NAME_LEAD_WIRE_FIELDS) {
      const classification = BRANCH_ROW_FIELD_EDIT[field];
      expect(BRANCH_PATCH_FIELD_VALUES.has(classification)).toBe(false);
    }
  });

  it("classifies the Priority column as the PATCH-able Priority field", () => {
    for (const [columnId, expectedField] of Object.entries(
      BRANCH_PATCHABLE_COLUMNS
    )) {
      const fields = BRANCH_COLUMN_WIRE_FIELDS[columnId];
      expect(fields, `column ${columnId}`).toBeDefined();
      for (const field of fields ?? []) {
        expect(
          BRANCH_ROW_FIELD_EDIT[field],
          `column ${columnId} field ${field}`
        ).toBe(expectedField);
      }
    }
  });

  it("classifies the Tags column as own_route", () => {
    for (const field of BRANCH_COLUMN_WIRE_FIELDS.tags ?? []) {
      expect(BRANCH_ROW_FIELD_EDIT[field]).toBe(ArtifactRowFieldEdit.OwnRoute);
    }
  });

  it("classifies the Project column's writable id as own_route, its display name not", () => {
    expect(BRANCH_ROW_FIELD_EDIT.projectId).toBe(ArtifactRowFieldEdit.OwnRoute);
    expect(BRANCH_ROW_FIELD_EDIT.projectName).not.toBe(
      ArtifactRowFieldEdit.OwnRoute
    );
  });

  it("classifies every other column as a non-PATCH class", () => {
    const patchableColumnIds = new Set(Object.keys(BRANCH_PATCHABLE_COLUMNS));
    for (const [columnId, fields] of Object.entries(
      BRANCH_COLUMN_WIRE_FIELDS
    )) {
      if (patchableColumnIds.has(columnId)) {
        continue;
      }
      for (const field of fields) {
        const classification = BRANCH_ROW_FIELD_EDIT[field];
        expect(
          BRANCH_PATCH_FIELD_VALUES.has(classification),
          `column ${columnId} field ${field} resolved to a PATCH field (${classification})`
        ).toBe(false);
      }
    }
  });
});
