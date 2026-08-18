/**
 * @file install-matrix-view.test.ts
 * @description Behavioral coverage for the org-wide install-matrix view-model
 * (FEA-4081). Fixtures are real `DistributionTargetStatus` DTOs fed through the
 * FEA-4072a `buildComponentInstallMatrix`, so the view-model is exercised over
 * the same cell set the admin surface receives — not a hand-built shortcut.
 *
 * The asserts pin the contract the feature promises:
 *  - the pivot renders one cell per (target × harness) coordinate from the
 *    stored statuses;
 *  - the card rollup reconciles with the grid (card counts == matrix rows);
 *  - filtering by machine / harness / status narrows correctly;
 *  - offline and failed rows stay visible and filterable, never dropped.
 * No source scans, no timing.
 */

import {
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { describe, expect, it } from "vitest";
import {
  buildInstallMatrixView,
  countMatrixStates,
  EMPTY_INSTALL_MATRIX_FILTER,
  filterInstallMatrixView,
  INSTALL_MATRIX_FILTER_ALL,
  pageMatrixRows,
  pruneStaleFilterSelections,
} from "../install-matrix-view";
import { PackInstallState } from "../install-state";
import {
  buildComponentInstallMatrix,
  type InstallMatrixTarget,
} from "../pack-install-matrix";

const CLAUDE: Harness = "claude";
const CODEX: Harness = "codex";

const COMPONENT = { id: "cmp-1", name: "pre-commit-guard" };

// Distinct-per-harness routing: DistributionTargetStatus has no harness column,
// so a device expanded into two harness cells routes each status row to the
// harness it applies to via `matchesHarness`. Fixture rows stamp the harness in
// `installRunId` so the predicate can pick the right one deterministically.
function statusFor(
  computeTargetId: string,
  harness: Harness,
  overrides: Partial<DistributionTargetStatusDto> = {}
): DistributionTargetStatusDto {
  return {
    id: `ts-${computeTargetId}-${harness}`,
    distributionId: "dist-1",
    computeTargetId,
    userId: null,
    status: DistributionTargetStatusValue.Installed,
    installedVersion: "2.4.0",
    installRunId: harness,
    overriddenLocally: false,
    failureReason: null,
    installedAt: "2026-07-01T00:00:00.000Z",
    enabledAt: null,
    reportedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

function targetCell(
  computeTargetId: string,
  computeTargetName: string,
  harness: Harness,
  online: boolean
): InstallMatrixTarget {
  return {
    computeTargetId,
    computeTargetName,
    harness,
    online,
    matchesHarness: (status) => status.installRunId === harness,
  };
}

// Four machines × two harnesses, exercising the honest states the matrix must
// keep visible: an all-installed box, an offline box (state unknown), a box with
// a failed install, and a box with a per-harness update/decline mix.
const STATUSES: DistributionTargetStatusDto[] = [
  statusFor("tgt-a", CLAUDE),
  statusFor("tgt-a", CODEX),
  // tgt-b is offline — the online:false target forces Offline regardless of row.
  statusFor("tgt-b", CLAUDE),
  statusFor("tgt-b", CODEX),
  statusFor("tgt-c", CLAUDE, {
    status: DistributionTargetStatusValue.Failed,
    failureReason: "npm install exited 1",
    installedVersion: null,
  }),
  statusFor("tgt-c", CODEX),
  statusFor("tgt-d", CLAUDE, {
    status: DistributionTargetStatusValue.Declined,
    installedVersion: null,
  }),
  // tgt-d has no Codex row → online-with-no-row resolves to NotInstalled.
];

const TARGETS: InstallMatrixTarget[] = [
  targetCell("tgt-a", "parkers-mbp", CLAUDE, true),
  targetCell("tgt-a", "parkers-mbp", CODEX, true),
  targetCell("tgt-b", "mbp-ci-runner", CLAUDE, false),
  targetCell("tgt-b", "mbp-ci-runner", CODEX, false),
  targetCell("tgt-c", "linux-build-02", CLAUDE, true),
  targetCell("tgt-c", "linux-build-02", CODEX, true),
  targetCell("tgt-d", "win-desktop-01", CLAUDE, true),
  targetCell("tgt-d", "win-desktop-01", CODEX, true),
];

function buildView() {
  const matrix = buildComponentInstallMatrix(COMPONENT, STATUSES, TARGETS);
  return buildInstallMatrixView(matrix);
}

describe("buildInstallMatrixView", () => {
  it("pivots the FEA-4072a cells into a per-(target × harness) grid", () => {
    const view = buildView();
    expect(view.harnesses).toEqual([CLAUDE, CODEX]);
    // One row per distinct compute target.
    expect(view.rows.map((row) => row.computeTargetId)).toEqual([
      "tgt-a",
      "tgt-b",
      "tgt-c",
      "tgt-d",
    ]);
    // Every row is rectangular: a cell per harness column.
    for (const row of view.rows) {
      expect(Object.keys(row.cellsByHarness).sort()).toEqual([CLAUDE, CODEX]);
    }
    // The flat cell list = rows × harnesses, the reconciliation source.
    expect(view.cells).toHaveLength(view.rows.length * view.harnesses.length);
  });

  it("renders each cell's honest state from the stored status + reachability", () => {
    const view = buildView();
    const byId = new Map(view.rows.map((row) => [row.computeTargetId, row]));

    expect(byId.get("tgt-a")?.cellsByHarness[CLAUDE].state).toBe(
      PackInstallState.Installed
    );
    // Offline target: both harness cells read Offline, not last-known installed.
    expect(byId.get("tgt-b")?.cellsByHarness[CLAUDE].state).toBe(
      PackInstallState.Offline
    );
    expect(byId.get("tgt-b")?.cellsByHarness[CODEX].state).toBe(
      PackInstallState.Offline
    );
    // Failed install stays a Failed cell carrying its failure reason.
    const failed = byId.get("tgt-c")?.cellsByHarness[CLAUDE];
    expect(failed?.state).toBe(PackInstallState.Failed);
    expect(failed?.failureReason).toBe("npm install exited 1");
    // Declined → NotInstalled (the user opted out; honestly available).
    expect(byId.get("tgt-d")?.cellsByHarness[CLAUDE].state).toBe(
      PackInstallState.NotInstalled
    );
    // Online target with no status row for a harness → NotInstalled.
    expect(byId.get("tgt-d")?.cellsByHarness[CODEX].state).toBe(
      PackInstallState.NotInstalled
    );
  });

  it("renders an empty view for a null / absent matrix", () => {
    const empty = buildInstallMatrixView(null);
    expect(empty.rows).toHaveLength(0);
    expect(empty.harnesses).toHaveLength(0);
    expect(empty.cells).toHaveLength(0);
  });
});

describe("rollup reconciliation (card counts == matrix rows)", () => {
  it("counts every cell the grid renders, summing to the total", () => {
    const view = buildView();
    const rollup = countMatrixStates(view.cells);

    // The card sum equals the flattened cell count — no number the grid can't show.
    expect(rollup.total).toBe(view.cells.length);
    const perStateSum = Object.values(PackInstallState).reduce(
      (sum, state) => sum + rollup[state],
      0
    );
    expect(perStateSum).toBe(rollup.total);
  });

  it("reconciles each state count with the cells actually present in the grid", () => {
    const view = buildView();
    const rollup = countMatrixStates(view.cells);

    // Recount independently from the rendered rows — the card must match the grid.
    const gridCounts: Record<string, number> = {};
    for (const row of view.rows) {
      for (const cell of Object.values(row.cellsByHarness)) {
        gridCounts[cell.state] = (gridCounts[cell.state] ?? 0) + 1;
      }
    }
    for (const state of Object.values(PackInstallState)) {
      expect(rollup[state]).toBe(gridCounts[state] ?? 0);
    }
    // Spot-check the honest states: 2 offline cells (tgt-b × 2 harnesses),
    // 1 failed (tgt-c claude).
    expect(rollup[PackInstallState.Offline]).toBe(2);
    expect(rollup[PackInstallState.Failed]).toBe(1);
  });

  it("keeps the card reconciled with the grid AFTER filtering", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      harness: CLAUDE,
    });
    const rollup = countMatrixStates(filtered.cells);

    const gridCells = filtered.rows.flatMap((row) =>
      Object.values(row.cellsByHarness)
    );
    expect(rollup.total).toBe(gridCells.length);
    for (const state of Object.values(PackInstallState)) {
      const gridCount = gridCells.filter((cell) => cell.state === state).length;
      expect(rollup[state]).toBe(gridCount);
    }
  });
});

describe("filterInstallMatrixView", () => {
  it("narrows to one machine, keeping only that target's row", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      computeTargetId: "tgt-c",
    });
    expect(filtered.rows.map((row) => row.computeTargetId)).toEqual(["tgt-c"]);
    // Both harness columns for that machine survive.
    expect(filtered.harnesses).toEqual([CLAUDE, CODEX]);
  });

  it("narrows to one harness, collapsing the grid to that single column", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      harness: CODEX,
    });
    expect(filtered.harnesses).toEqual([CODEX]);
    for (const row of filtered.rows) {
      expect(Object.keys(row.cellsByHarness)).toEqual([CODEX]);
    }
  });

  it("narrows to one status, keeping only rows with a matching cell", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      state: PackInstallState.Failed,
    });
    // Only tgt-c carries a Failed cell.
    expect(filtered.rows.map((row) => row.computeTargetId)).toEqual(["tgt-c"]);
    const kept = filtered.rows.flatMap((row) =>
      Object.values(row.cellsByHarness)
    );
    expect(kept).toHaveLength(1);
    expect(kept[0]?.state).toBe(PackInstallState.Failed);
  });

  it("returns the full grid when no dimension is filtered", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, EMPTY_INSTALL_MATRIX_FILTER);
    expect(filtered.rows).toHaveLength(view.rows.length);
    expect(filtered.cells).toHaveLength(view.cells.length);
  });
});

describe("offline / failed rows stay visible and filterable", () => {
  it("keeps offline and failed rows in the unfiltered grid", () => {
    const view = buildView();
    const ids = view.rows.map((row) => row.computeTargetId);
    // The offline (tgt-b) and failed (tgt-c) machines are present, not dropped.
    expect(ids).toContain("tgt-b");
    expect(ids).toContain("tgt-c");
  });

  it("can filter TO the offline status", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      state: PackInstallState.Offline,
    });
    // Only the offline machine survives, with both its offline cells.
    expect(filtered.rows.map((row) => row.computeTargetId)).toEqual(["tgt-b"]);
    const cells = filtered.rows.flatMap((row) =>
      Object.values(row.cellsByHarness)
    );
    expect(cells).toHaveLength(2);
    for (const cell of cells) {
      expect(cell.state).toBe(PackInstallState.Offline);
    }
  });

  it("a status filter for an unrelated state does not silently keep offline rows", () => {
    const view = buildView();
    const filtered = filterInstallMatrixView(view, {
      ...EMPTY_INSTALL_MATRIX_FILTER,
      state: PackInstallState.Installed,
    });
    // Filtering to Installed excludes the offline machine — offline is an
    // ordinary status a filter narrows, not a special-cased always-shown row.
    expect(filtered.rows.map((row) => row.computeTargetId)).not.toContain(
      "tgt-b"
    );
  });
});

describe("pageMatrixRows", () => {
  it("slices rows into pages and clamps an out-of-range page", () => {
    const view = buildView();
    const first = pageMatrixRows(view.rows, 0, 2);
    expect(first.rows).toHaveLength(2);
    expect(first.totalPages).toBe(2);
    expect(first.page).toBe(0);

    const clamped = pageMatrixRows(view.rows, 99, 2);
    expect(clamped.page).toBe(1);
    expect(clamped.rows.map((row) => row.computeTargetId)).toEqual([
      "tgt-c",
      "tgt-d",
    ]);
  });

  it("floors a negative page to 0 and a page size below 1 to 1", () => {
    const view = buildView();
    const page = pageMatrixRows(view.rows, -5, 0);
    expect(page.page).toBe(0);
    // pageSize floored to 1 → one row per page.
    expect(page.rows).toHaveLength(1);
    expect(page.totalPages).toBe(view.rows.length);
  });

  it("keeps ALL filter as the no-op sentinel", () => {
    expect(EMPTY_INSTALL_MATRIX_FILTER.computeTargetId).toBe(
      INSTALL_MATRIX_FILTER_ALL
    );
    expect(EMPTY_INSTALL_MATRIX_FILTER.harness).toBe(INSTALL_MATRIX_FILTER_ALL);
    expect(EMPTY_INSTALL_MATRIX_FILTER.state).toBe(INSTALL_MATRIX_FILTER_ALL);
  });
});

describe("pruneStaleFilterSelections", () => {
  it("clears a machine selection that no longer exists in the refreshed view", () => {
    const view = buildView();
    const pruned = pruneStaleFilterSelections(
      { ...EMPTY_INSTALL_MATRIX_FILTER, computeTargetId: "tgt-gone" },
      view
    );
    expect(pruned.computeTargetId).toBe(INSTALL_MATRIX_FILTER_ALL);
  });

  it("clears a harness selection that no longer exists in the refreshed view", () => {
    const view = buildView();
    const pruned = pruneStaleFilterSelections(
      { ...EMPTY_INSTALL_MATRIX_FILTER, harness: "gemini" },
      view
    );
    expect(pruned.harness).toBe(INSTALL_MATRIX_FILTER_ALL);
  });

  it("keeps selections that still exist and leaves status untouched", () => {
    const view = buildView();
    const filter = {
      computeTargetId: "tgt-a",
      harness: CLAUDE,
      state: PackInstallState.Failed as string,
    };
    const pruned = pruneStaleFilterSelections(filter, view);
    // Same object reference back when nothing was stale — a no-op is a no-op.
    expect(pruned).toBe(filter);
    expect(pruned.state).toBe(PackInstallState.Failed);
  });
});
