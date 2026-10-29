import { render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it } from "vitest";
import { branchRow } from "../../lib/__tests__/branch-row-fixture";
import { renderApprovedBranchLead } from "../approved-branches-grid-adapter";

describe("Branch direct-artifact comments in the shared lead", () => {
  it("shows a measured count with the shared accessible comment label", () => {
    render(renderApprovedBranchLead(branchRow({ commentCount: 3 })));
    expect(screen.getByText("3 comments")).toBeInTheDocument();
  });
  it("does not present unknown or measured zero as a discussed branch", () => {
    const result = render(renderApprovedBranchLead(branchRow()));
    expect(
      screen.queryByText("comments", { exact: false })
    ).not.toBeInTheDocument();
    result.rerender(renderApprovedBranchLead(branchRow({ commentCount: 0 })));
    expect(
      screen.queryByText("comments", { exact: false })
    ).not.toBeInTheDocument();
  });

  it("keeps the compatibility card link inline while retaining the narrow link hit area", () => {
    const row = branchRow();
    const renderLink = ({
      children,
      className,
    }: {
      children: ReactNode;
      className: string;
    }) => (
      <a className={className} href="/branches/example">
        {children}
      </a>
    );
    const result = render(renderApprovedBranchLead(row, undefined, renderLink));
    expect(screen.getByRole("link")).toHaveClass("min-w-0");
    expect(screen.getByRole("link")).not.toHaveClass("min-h-6");

    result.rerender(
      renderApprovedBranchLead(row, undefined, renderLink, {
        showStatusIcon: true,
      })
    );
    expect(screen.getByRole("link")).toHaveClass("min-h-6");
  });
});
