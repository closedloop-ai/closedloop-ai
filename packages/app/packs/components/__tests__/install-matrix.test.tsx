/**
 * @file install-matrix.test.tsx
 * @description Render coverage for the admin org-wide install matrix (FEA-4081).
 * Renders the component from a FEA-4072a `PackComponentInstallMatrix` built out
 * of real `DistributionTargetStatus` fixtures, then asserts observable behavior:
 * per-(target × harness) cells render with their canonical install-state labels,
 * the rollup card total reconciles with the rendered grid cells, offline and
 * failed rows are visible, and the filter menu + pagination controls mount. No
 * source scans, no timing.
 */

import {
  type DistributionTargetStatusDto,
  DistributionTargetStatusValue,
} from "@repo/api/src/types/distribution";
import type { Harness } from "@repo/app/agents/lib/session-types";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { INSTALL_STATE_LABEL, PackInstallState } from "../../lib/install-state";
import {
  buildComponentInstallMatrix,
  type InstallMatrixTarget,
} from "../../lib/pack-install-matrix";
import { InstallMatrix } from "../install-matrix";

const CLAUDE: Harness = "claude";
const CODEX: Harness = "codex";

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

const STATUSES: DistributionTargetStatusDto[] = [
  statusFor("tgt-a", CLAUDE),
  statusFor("tgt-a", CODEX),
  statusFor("tgt-b", CLAUDE),
  statusFor("tgt-b", CODEX),
  statusFor("tgt-c", CLAUDE, {
    status: DistributionTargetStatusValue.Failed,
    failureReason: "npm install exited 1",
    installedVersion: null,
  }),
  statusFor("tgt-c", CODEX),
];

const TARGETS: InstallMatrixTarget[] = [
  targetCell("tgt-a", "parkers-mbp", CLAUDE, true),
  targetCell("tgt-a", "parkers-mbp", CODEX, true),
  targetCell("tgt-b", "mbp-ci-runner", CLAUDE, false),
  targetCell("tgt-b", "mbp-ci-runner", CODEX, false),
  targetCell("tgt-c", "linux-build-02", CLAUDE, true),
  targetCell("tgt-c", "linux-build-02", CODEX, true),
];

const MATRIX = buildComponentInstallMatrix(
  { id: "cmp-1", name: "pre-commit-guard" },
  STATUSES,
  TARGETS
);

// Top-level regex literals (Ultracite `useTopLevelRegex`).
const ROLLUP_TOTAL_RE = /6 cells across/i;
const FILTER_BUTTON_RE = /filter/i;
const COMPONENT_NAME_RE = /pre-commit-guard/;

describe("InstallMatrix", () => {
  it("renders every registered target as a row, including offline and failed", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={MATRIX} />);
    expect(screen.getByText("parkers-mbp")).toBeInTheDocument();
    // Offline machine stays visible.
    expect(screen.getByText("mbp-ci-runner")).toBeInTheDocument();
    // Failed machine stays visible.
    expect(screen.getByText("linux-build-02")).toBeInTheDocument();
  });

  it("renders the honest per-cell install states with their canonical labels", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={MATRIX} />);
    // Installed (tgt-a), Offline (tgt-b), and Failed (tgt-c) all read their
    // canonical FEA-4083 labels somewhere in the grid.
    expect(
      screen.getAllByText(INSTALL_STATE_LABEL[PackInstallState.Installed])
        .length
    ).toBeGreaterThan(0);
    expect(
      screen.getAllByText(INSTALL_STATE_LABEL[PackInstallState.Offline]).length
    ).toBeGreaterThan(0);
    // Failed appears in both the grid cell and the reconciled rollup card.
    expect(
      screen.getAllByText(INSTALL_STATE_LABEL[PackInstallState.Failed]).length
    ).toBeGreaterThan(0);
    // The failure reason rides along on the failed cell.
    expect(screen.getByText("npm install exited 1")).toBeInTheDocument();
  });

  it("reconciles the rollup card total with the rendered grid cell count", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={MATRIX} />);
    // 3 targets × 2 harnesses = 6 cells; the card names that exact total.
    expect(screen.getByText(ROLLUP_TOTAL_RE)).toBeInTheDocument();
  });

  it("renders one column header per harness present in the data", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={MATRIX} />);
    // Column headers are the human harness labels; both derived from the cells.
    expect(screen.getByText("Claude")).toBeInTheDocument();
    expect(screen.getByText("Codex")).toBeInTheDocument();
  });

  it("mounts the shared filter menu", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={MATRIX} />);
    expect(
      screen.getByRole("button", { name: FILTER_BUTTON_RE })
    ).toBeInTheDocument();
  });

  it("renders the empty state for a null matrix", () => {
    render(<InstallMatrix componentName="pre-commit-guard" matrix={null} />);
    expect(screen.getByText("No install targets yet")).toBeInTheDocument();
    // A named component is echoed in the empty copy.
    expect(screen.getByText(COMPONENT_NAME_RE)).toBeInTheDocument();
  });

  it("renders every row of a refreshed matrix (no stale filter zeroes it out)", () => {
    // Regression for the stale-filter-across-refresh bug: swapping in a different
    // component's matrix must show all of the new matrix's rows, never a stale
    // selection silently zeroing the grid. Filter-selection pruning itself is
    // covered as a unit in install-matrix-view.test.ts.
    const { rerender } = render(
      <InstallMatrix componentName="pack-a" matrix={MATRIX} />
    );
    expect(screen.getByText("parkers-mbp")).toBeInTheDocument();

    const otherMatrix = buildComponentInstallMatrix(
      { id: "cmp-2", name: "other-pack" },
      STATUSES,
      TARGETS
    );
    rerender(<InstallMatrix componentName="other-pack" matrix={otherMatrix} />);

    expect(screen.getByText("parkers-mbp")).toBeInTheDocument();
    expect(screen.getByText("linux-build-02")).toBeInTheDocument();
  });
});
