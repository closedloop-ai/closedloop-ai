/**
 * @file member-targets.test.ts
 * @description Behavioral coverage for the FEA-4077 member per-machine model.
 * The web member read (registered nodes) and the desktop local read (this
 * machine) both resolve into the SAME canonical FEA-4083 install-state cells,
 * honestly reflecting installed / not-installed / updatable / offline per
 * target. No source scans, no timing.
 */

import {
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import { describe, expect, it } from "vitest";
import { PackInstallState } from "../install-state";
import {
  LOCAL_MACHINE_TARGET_ID,
  localMachineInstallMatrix,
  type MemberComputeTarget,
  memberComputeTargetsToInstallTargets,
  memberInstallMatrix,
  memberTargetCells,
} from "../member-targets";
import type { PackComponentInstallMatrix } from "../pack-install-matrix";
import type { PackView } from "../pack-view";

function pack(overrides: Partial<PackView> = {}): PackView {
  return {
    id: "pack-1",
    name: "code",
    verified: true,
    harnesses: ["claude"],
    installedHarnesses: [],
    installedByMe: false,
    contents: [],
    ...overrides,
  };
}

function target(
  overrides: Partial<MemberComputeTarget> & { id: string }
): MemberComputeTarget {
  return {
    machineName: overrides.id,
    isOnline: true,
    ...overrides,
  };
}

function status(
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
    installedAt: null,
    enabledAt: null,
    reportedAt: null,
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-01T00:00:00.000Z",
    ...overrides,
  };
}

describe("memberComputeTargetsToInstallTargets", () => {
  it("maps a node's harness + reachability into an install-matrix target", () => {
    const [resolved] = memberComputeTargetsToInstallTargets([
      target({ id: "n1", machineName: "Laptop", selectedHarness: "codex" }),
    ]);
    expect(resolved).toMatchObject({
      computeTargetId: "n1",
      computeTargetName: "Laptop",
      harness: "codex",
      online: true,
    });
  });

  it("defaults a node with no selectedHarness to claude", () => {
    const [resolved] = memberComputeTargetsToInstallTargets([
      target({ id: "n1", selectedHarness: null }),
    ]);
    expect(resolved.harness).toBe("claude");
  });
});

describe("memberInstallMatrix (web member read of registered nodes)", () => {
  it("returns an empty matrix (not null) when the member has no registered nodes", () => {
    // A present-but-empty matrix is the web read's "ran, found no nodes" signal,
    // distinct from an absent matrix (the desktop local read) — so the web block
    // renders its honest empty state instead of a fabricated local row.
    expect(memberInstallMatrix(pack(), [])).toEqual([]);
  });

  it("reads a node's install state from its distribution status row", () => {
    const matrix = memberInstallMatrix(
      pack(),
      [target({ id: "n1", machineName: "Laptop" })],
      [status({ computeTargetId: "n1" })]
    );
    const cells = (matrix as PackComponentInstallMatrix[])[0].cells;
    expect(cells).toHaveLength(1);
    expect(cells[0].computeTargetId).toBe("n1");
    expect(cells[0].state).toBe(PackInstallState.Installed);
  });

  it("shows an online node with no status row as Not installed (honest, read-only)", () => {
    const matrix = memberInstallMatrix(pack(), [
      target({ id: "n1", isOnline: true }),
    ]);
    const cells = (matrix as PackComponentInstallMatrix[])[0].cells;
    expect(cells[0].state).toBe(PackInstallState.NotInstalled);
  });

  it("shows an offline node honestly as Offline, never optimistic", () => {
    const matrix = memberInstallMatrix(
      pack(),
      [target({ id: "n1", isOnline: false })],
      // Even with an installed status row, an unreachable node reads Offline.
      [status({ computeTargetId: "n1" })]
    );
    const cells = (matrix as PackComponentInstallMatrix[])[0].cells;
    expect(cells[0].state).toBe(PackInstallState.Offline);
  });

  it("reflects a failed org push as a failed cell", () => {
    const matrix = memberInstallMatrix(
      pack(),
      [target({ id: "n1" })],
      [
        status({
          computeTargetId: "n1",
          status: DistributionTargetStatusValue.Failed,
          failureReason: "install script exited 1",
        }),
      ]
    );
    const cells = (matrix as PackComponentInstallMatrix[])[0].cells;
    expect(cells[0].state).toBe(PackInstallState.Failed);
    expect(cells[0].failureReason).toBe("install script exited 1");
  });
});

describe("localMachineInstallMatrix (desktop local read)", () => {
  it("marks a locally-installed harness Installed and others Not installed", () => {
    const cells = localMachineInstallMatrix(
      pack({ harnesses: ["claude", "codex"], installedHarnesses: ["claude"] })
    );
    const byHarness = new Map(cells.map((cell) => [cell.harness, cell.state]));
    expect(byHarness.get("claude")).toBe(PackInstallState.Installed);
    expect(byHarness.get("codex")).toBe(PackInstallState.NotInstalled);
  });

  it("keys the local cells on the synthetic this-machine id", () => {
    const cells = localMachineInstallMatrix(pack());
    expect(cells[0].computeTargetId).toBe(LOCAL_MACHINE_TARGET_ID);
  });

  it("always emits a cell even for a pack that lists no harness", () => {
    const cells = localMachineInstallMatrix(pack({ harnesses: [] }));
    expect(cells).toHaveLength(1);
    expect(cells[0].harness).toBe("claude");
  });
});

describe("memberTargetCells (source resolution)", () => {
  it("prefers the loaded installMatrix (web registered-node read)", () => {
    const matrix = memberInstallMatrix(pack(), [
      target({ id: "n1", machineName: "Laptop" }),
    ]) as PackComponentInstallMatrix[];
    const cells = memberTargetCells(pack({ installMatrix: matrix }));
    expect(cells[0].computeTargetId).toBe("n1");
  });

  it("falls back to the desktop local cells when no matrix was loaded", () => {
    const cells = memberTargetCells(
      pack({ installedHarnesses: ["claude"], installMatrix: null })
    );
    expect(cells[0].computeTargetId).toBe(LOCAL_MACHINE_TARGET_ID);
    expect(cells[0].state).toBe(PackInstallState.Installed);
  });
});
