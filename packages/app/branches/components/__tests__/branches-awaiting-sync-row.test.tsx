import {
  BranchDataState,
  type BranchDataState as BranchDataStateType,
} from "@repo/api/src/types/branch";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../shared/storybook/decorators";
import type { BranchRow } from "../../lib/branch-row";
import { BRANCH_SAMPLE_ROWS } from "../../lib/branch-sample-data";
import { BranchesTable } from "../branches-table";

const RE_SYNCING_BRANCH_NAME =
  /Syncing branch data\.\s*agent\/embeddings-store-reindex/;

const branchRow: BranchRow = {
  ...BRANCH_SAMPLE_ROWS[0]!,
  id: "awaiting-sync-branch",
  branchName: "agent/embeddings-store-reindex",
};

describe("approved Branches awaiting-sync row", () => {
  it("replaces only the Name icon with an accessible loading indicator", () => {
    const row = {
      ...branchRow,
      dataState: BranchDataState.AwaitingSync,
    };
    const view = render(
      <BranchesTable
        approved
        getBranchHref={(item) => `#/branches/${item.id}`}
        items={[row]}
      />,
      { wrapper: AppCoreStoryProviders }
    );

    expect(screen.getAllByRole("columnheader")).toHaveLength(10);
    const link = screen.getByRole("link", { name: RE_SYNCING_BRANCH_NAME });
    expect(link).toHaveAttribute("href", `#/branches/${row.id}`);
    expect(within(link).getByText(row.branchName)).toBeVisible();

    const accessibleStatus = within(link).getByText("Syncing branch data.");
    expect(accessibleStatus).toHaveClass("sr-only");
    expect(link.querySelector("svg.animate-spin")).toHaveAttribute(
      "aria-hidden",
      "true"
    );

    expect(screen.getByText(row.owner)).toBeVisible();
    expect(screen.queryByText("Syncing…")).not.toBeInTheDocument();
    expect(view.container.textContent).not.toContain("*");
  });

  it.each([
    ["ready", BranchDataState.Ready],
    ["not present", BranchDataState.NotPresent],
    ["no sessions", BranchDataState.NoSessions],
    ["missing", undefined],
    ["unknown", "future_state" as BranchDataStateType],
  ])("keeps the ordinary Name icon for %s dataState", (_label, dataState) => {
    const row: BranchRow = {
      ...branchRow,
      id: `ordinary-${_label}`,
      ...(dataState === undefined ? {} : { dataState }),
    };
    const view = render(<BranchesTable approved items={[row]} />);

    expect(screen.queryByText("Syncing branch data.")).not.toBeInTheDocument();
    const name = screen.getByText(row.branchName);
    expect(name).toBeVisible();
    const ordinaryIcon = name.closest("span.flex")?.querySelector("svg");
    expect(ordinaryIcon).not.toBeNull();
    expect(ordinaryIcon).not.toHaveClass("animate-spin");
    expect(view.container.textContent).not.toContain("*");
  });
});
