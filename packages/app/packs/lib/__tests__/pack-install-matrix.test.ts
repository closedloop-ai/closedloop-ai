import {
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { describe, expect, it } from "vitest";
import { PackInstallState } from "../install-state";
import {
  buildComponentInstallMatrix,
  buildInstallCells,
  deriveCellState,
  distributionStatusToInstallState,
  type InstallMatrixTarget,
} from "../pack-install-matrix";

const CLAUDE: Harness = "claude";
const CODEX: Harness = "codex";

function makeTarget(
  overrides: Partial<InstallMatrixTarget> & { computeTargetId: string }
): InstallMatrixTarget {
  return {
    computeTargetName: overrides.computeTargetId,
    harness: CLAUDE,
    online: true,
    ...overrides,
  };
}

function makeStatus(
  overrides: Partial<DistributionTargetStatusDto> & { computeTargetId: string }
): DistributionTargetStatusDto {
  return {
    id: `ts-${overrides.computeTargetId}`,
    distributionId: "dist-1",
    userId: null,
    status: DistributionTargetStatusValue.Installed,
    installedVersion: "1.0.0",
    installRunId: null,
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

describe("distributionStatusToInstallState", () => {
  it("maps installed/enabled to Installed", () => {
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.Installed)
    ).toBe(PackInstallState.Installed);
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.Enabled)
    ).toBe(PackInstallState.Installed);
  });

  it("maps in-flight statuses to Converting", () => {
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.Pending)
    ).toBe(PackInstallState.Converting);
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.OptedIn)
    ).toBe(PackInstallState.Converting);
  });

  it("maps failed to Failed and declined to NotInstalled", () => {
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.Failed)
    ).toBe(PackInstallState.Failed);
    expect(
      distributionStatusToInstallState(DistributionTargetStatusValue.Declined)
    ).toBe(PackInstallState.NotInstalled);
  });
});

describe("deriveCellState", () => {
  it("forces Offline for an unreachable target regardless of stored status", () => {
    // A device that WAS installed but is now offline reads Offline — its current
    // truth is unknown, so the cell is stale-but-honest, never optimistic.
    const state = deriveCellState(
      makeStatus({
        computeTargetId: "ct-1",
        status: DistributionTargetStatusValue.Installed,
      }),
      false
    );
    expect(state).toBe(PackInstallState.Offline);
  });

  it("maps an unknown/version-skewed stored status to Offline, not Installed", () => {
    // An older/newer desktop reporting a status this build can't classify must
    // degrade to the safe unknown state, never optimistically to Installed.
    const status: DistributionTargetStatusDto = {
      ...makeStatus({ computeTargetId: "ct-1" }),
      // A future desktop reports a status value this build's union doesn't know.
      status: "some_future_status" as DistributionTargetStatusValue,
    };
    expect(deriveCellState(status, true)).toBe(PackInstallState.Offline);
  });

  it("maps a missing status on an online target to Offline via the unknown guard", () => {
    expect(deriveCellState(undefined, true)).toBe(PackInstallState.Offline);
  });
});

describe("buildInstallCells", () => {
  it("computes correct per-(target × harness) cells from stored statuses", () => {
    // Target A (claude): installed. Target B (codex): no row → not installed.
    // Target C (claude): offline → Offline even though it reported installed.
    const targets = [
      makeTarget({
        computeTargetId: "ct-a",
        computeTargetName: "MacBook A",
        harness: CLAUDE,
        online: true,
      }),
      makeTarget({
        computeTargetId: "ct-b",
        computeTargetName: "MacBook B",
        harness: CODEX,
        online: true,
      }),
      makeTarget({
        computeTargetId: "ct-c",
        computeTargetName: "MacBook C",
        harness: CLAUDE,
        online: false,
      }),
    ];
    const statuses = [
      makeStatus({
        computeTargetId: "ct-a",
        status: DistributionTargetStatusValue.Installed,
        installedVersion: "2.1.0",
      }),
      makeStatus({
        computeTargetId: "ct-c",
        status: DistributionTargetStatusValue.Installed,
      }),
    ];

    const cells = buildInstallCells(statuses, targets);

    expect(cells).toHaveLength(3);

    const cellA = cells.find((c) => c.computeTargetId === "ct-a");
    expect(cellA?.state).toBe(PackInstallState.Installed);
    expect(cellA?.harness).toBe(CLAUDE);
    expect(cellA?.installedVersion).toBe("2.1.0");

    const cellB = cells.find((c) => c.computeTargetId === "ct-b");
    expect(cellB?.state).toBe(PackInstallState.NotInstalled);
    expect(cellB?.harness).toBe(CODEX);

    const cellC = cells.find((c) => c.computeTargetId === "ct-c");
    expect(cellC?.state).toBe(PackInstallState.Offline);
  });

  it("carries failureReason onto a Failed cell", () => {
    const cells = buildInstallCells(
      [
        makeStatus({
          computeTargetId: "ct-a",
          status: DistributionTargetStatusValue.Failed,
          failureReason: "npm install exited 1",
          installedVersion: null,
        }),
      ],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(cells[0]?.state).toBe(PackInstallState.Failed);
    expect(cells[0]?.failureReason).toBe("npm install exited 1");
  });

  it("skips status rows whose target isn't in the resolved target set", () => {
    // A status row for a compute target that no longer exists can't sit on a
    // real (target × harness) coordinate, so it produces no cell.
    const cells = buildInstallCells(
      [
        makeStatus({
          computeTargetId: "ct-gone",
          status: DistributionTargetStatusValue.Installed,
        }),
      ],
      [makeTarget({ computeTargetId: "ct-a", online: true })]
    );

    expect(cells).toHaveLength(1);
    expect(cells[0]?.computeTargetId).toBe("ct-a");
    // ct-a had no row and is online → NotInstalled.
    expect(cells[0]?.state).toBe(PackInstallState.NotInstalled);
  });

  it("routes each status row to its own harness cell when a device runs both harnesses under one computeTargetId", () => {
    // The P1 the review named: DistributionTargetStatus has no harness column, so
    // if one physical device (a single computeTargetId) is expanded into a Claude
    // cell and a Codex cell, a status-per-target lookup would relabel the SAME
    // install row onto both harnesses. The `matchesHarness` predicate routes each
    // row to the harness cell it actually belongs to, so switching/adding a
    // harness cannot copy one persisted install state across harnesses.
    const claudeRow = makeStatus({
      id: "ts-claude",
      computeTargetId: "ct-shared",
      status: DistributionTargetStatusValue.Installed,
      installedVersion: "2.0.0",
    });
    const codexRow = makeStatus({
      id: "ts-codex",
      computeTargetId: "ct-shared",
      status: DistributionTargetStatusValue.Failed,
      failureReason: "codex install failed",
      installedVersion: null,
    });

    const cells = buildInstallCells(
      [claudeRow, codexRow],
      [
        makeTarget({
          computeTargetId: "ct-shared",
          computeTargetName: "MacBook",
          harness: CLAUDE,
          matchesHarness: (s) => s.id === "ts-claude",
        }),
        makeTarget({
          computeTargetId: "ct-shared",
          computeTargetName: "MacBook",
          harness: CODEX,
          matchesHarness: (s) => s.id === "ts-codex",
        }),
      ]
    );

    expect(cells).toHaveLength(2);
    const claudeCell = cells.find((c) => c.harness === CLAUDE);
    expect(claudeCell?.state).toBe(PackInstallState.Installed);
    expect(claudeCell?.installedVersion).toBe("2.0.0");
    // The Codex cell reads ONLY the Codex row — the Claude install is not
    // relabeled onto it.
    const codexCell = cells.find((c) => c.harness === CODEX);
    expect(codexCell?.state).toBe(PackInstallState.Failed);
    expect(codexCell?.failureReason).toBe("codex install failed");
  });

  it("falls back to NotInstalled for a harness cell with no matching status row", () => {
    // Device runs Claude (installed) and Codex, but only the Claude row exists.
    // The Codex cell's predicate matches nothing → honestly NotInstalled, never
    // the Claude row's Installed state.
    const cells = buildInstallCells(
      [
        makeStatus({
          id: "ts-claude",
          computeTargetId: "ct-shared",
          status: DistributionTargetStatusValue.Installed,
        }),
      ],
      [
        makeTarget({
          computeTargetId: "ct-shared",
          harness: CLAUDE,
          matchesHarness: (s) => s.id === "ts-claude",
        }),
        makeTarget({
          computeTargetId: "ct-shared",
          harness: CODEX,
          matchesHarness: (s) => s.id === "ts-codex",
        }),
      ]
    );

    expect(cells.find((c) => c.harness === CLAUDE)?.state).toBe(
      PackInstallState.Installed
    );
    expect(cells.find((c) => c.harness === CODEX)?.state).toBe(
      PackInstallState.NotInstalled
    );
  });

  it("produces one cell per (target × harness) when the same device runs both harnesses", () => {
    // The axis is target × harness, so one physical device selected on two
    // harnesses is two distinct cells.
    const cells = buildInstallCells(
      [
        makeStatus({
          computeTargetId: "ct-claude",
          status: DistributionTargetStatusValue.Installed,
        }),
      ],
      [
        makeTarget({
          computeTargetId: "ct-claude",
          computeTargetName: "MacBook",
          harness: CLAUDE,
        }),
        makeTarget({
          computeTargetId: "ct-codex",
          computeTargetName: "MacBook",
          harness: CODEX,
        }),
      ]
    );

    expect(cells).toHaveLength(2);
    expect(cells.find((c) => c.harness === CLAUDE)?.state).toBe(
      PackInstallState.Installed
    );
    expect(cells.find((c) => c.harness === CODEX)?.state).toBe(
      PackInstallState.NotInstalled
    );
  });
});

describe("buildComponentInstallMatrix", () => {
  it("keys the matrix by the component id and name", () => {
    const matrix = buildComponentInstallMatrix(
      { id: "pack-1", name: "Content Pack" },
      [
        makeStatus({
          computeTargetId: "ct-a",
          status: DistributionTargetStatusValue.Installed,
        }),
      ],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(matrix.componentId).toBe("pack-1");
    expect(matrix.componentName).toBe("Content Pack");
    expect(matrix.cells).toHaveLength(1);
    expect(matrix.cells[0]?.state).toBe(PackInstallState.Installed);
  });
});

describe("Updatable derivation (catalog version)", () => {
  const installedAt = (computeTargetId: string, installedVersion: string) =>
    makeStatus({
      computeTargetId,
      status: DistributionTargetStatusValue.Installed,
      installedVersion,
    });

  it("derives Updatable when the installed version is behind the catalog version", () => {
    const matrix = buildComponentInstallMatrix(
      { id: "pack-1", name: "Content Pack", version: "2.4.0" },
      [installedAt("ct-a", "2.3.0")],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(matrix.cells[0]?.state).toBe(PackInstallState.Updatable);
  });

  it("keeps Installed when the installed version matches the catalog version", () => {
    const matrix = buildComponentInstallMatrix(
      { id: "pack-1", name: "Content Pack", version: "2.4.0" },
      [installedAt("ct-a", "2.4.0")],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(matrix.cells[0]?.state).toBe(PackInstallState.Installed);
  });

  it("leaves Installed when no catalog version is known (version-skew safe)", () => {
    const cells = buildInstallCells(
      [installedAt("ct-a", "2.3.0")],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(cells[0]?.state).toBe(PackInstallState.Installed);
  });

  it("does not promote a non-Installed cell to Updatable", () => {
    // A failed install stays Failed even against a newer catalog version — an
    // update prompt would lie about what's on the box.
    const matrix = buildComponentInstallMatrix(
      { id: "pack-1", name: "Content Pack", version: "2.4.0" },
      [
        makeStatus({
          computeTargetId: "ct-a",
          status: DistributionTargetStatusValue.Failed,
          installedVersion: "2.3.0",
          failureReason: "boom",
        }),
      ],
      [makeTarget({ computeTargetId: "ct-a" })]
    );

    expect(matrix.cells[0]?.state).toBe(PackInstallState.Failed);
  });

  it("leaves Installed when the installed version is unparseable", () => {
    const cells = buildInstallCells(
      [installedAt("ct-a", "nightly")],
      [makeTarget({ computeTargetId: "ct-a" })],
      "2.4.0"
    );

    expect(cells[0]?.state).toBe(PackInstallState.Installed);
  });
});
