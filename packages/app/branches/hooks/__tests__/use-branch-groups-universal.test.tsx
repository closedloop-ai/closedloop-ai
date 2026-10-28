import { ARTIFACT_STATUS_UNKNOWN_LABEL } from "@repo/api/src/types/artifact-status-display";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchListFilterFacet } from "@repo/api/src/types/branch-list-contract";
import { UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY } from "@repo/api/src/types/universal-artifact-status-flag";
import { makeBranchRow } from "@repo/app/branches/data-source/__tests__/branch-row-test-fixture";
import { useBranchGroups } from "@repo/app/branches/hooks/use-branch-groups";
import { adaptBranchRow } from "@repo/app/branches/lib/branch-row-adapter";
import {
  type TableGroupingState,
  TableGroupOrder,
} from "@repo/design-system/components/ui/table-toolbar-model";
import { render, renderHook, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const FLAGS = vi.hoisted(() => new Map<string, boolean>());

vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabledOptional: (key: string) => FLAGS.get(key) ?? false,
}));

describe("production Branch status groups with the universal champion", () => {
  beforeEach(() => {
    FLAGS.clear();
    FLAGS.set(UNIVERSAL_ARTIFACT_STATUS_FLAG_KEY, true);
  });

  it("renders a recognized primary group from member evidence", () => {
    const row = adaptBranchRow({
      ...makeBranchRow("review"),
      status: BranchStatus.Review,
    });
    const { result } = renderHook(() =>
      useBranchGroups([row], [row], grouping(BranchListFilterFacet.Status))
    );

    render(result.current?.[0]?.icon);
    expect(screen.getByText("Review")).toBeVisible();
    expect(
      screen.queryByText(ARTIFACT_STATUS_UNKNOWN_LABEL)
    ).not.toBeInTheDocument();
  });

  it("uses the same evidence seam for a secondary future-status group", () => {
    const row = {
      ...adaptBranchRow({
        ...makeBranchRow("future"),
        status: "future-status" as BranchStatus,
      }),
      owner: "Alex",
    };
    const { result } = renderHook(() =>
      useBranchGroups(
        [row],
        [row],
        grouping(BranchListFilterFacet.Owner, BranchListFilterFacet.Status)
      )
    );

    render(result.current?.[0]?.subgroups?.[0]?.icon);
    expect(screen.getByText("Unknown")).toBeVisible();
  });
});

function grouping(
  primaryFieldId: string,
  secondaryFieldId: string | null = null
): TableGroupingState {
  return {
    primary: {
      fieldId: primaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
    secondary: {
      fieldId: secondaryFieldId,
      order: TableGroupOrder.Ascending,
      showEmptyGroups: false,
    },
  };
}
