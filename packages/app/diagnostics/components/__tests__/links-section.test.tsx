import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { LinkStatsRow, LinkTotals } from "../../lib/diagnostics-payload";
import { LinksSection } from "../links-section";

const totals: LinkTotals = {
  totalLinks: 120,
  linkedSessions: 80,
  linkedArtifacts: 45,
};

describe("LinksSection", () => {
  it("renders the three summary totals", () => {
    render(<LinksSection linkStats={[]} linkTotals={totals} />);

    expect(screen.getByText("120")).toBeDefined();
    expect(screen.getByText("Total Links")).toBeDefined();
    expect(screen.getByText("80")).toBeDefined();
    expect(screen.getByText("Linked Sessions")).toBeDefined();
    expect(screen.getByText("45")).toBeDefined();
    expect(screen.getByText("Linked Artifacts")).toBeDefined();
  });

  it("shows an empty state when there are no link method rows", () => {
    render(<LinksSection linkStats={[]} linkTotals={totals} />);
    expect(screen.getByText("No links found")).toBeDefined();
  });

  it("renders a row per relation/method pair with its count", () => {
    const linkStats: LinkStatsRow[] = [
      { relation: "session_pr", method: "branch_name", count: 12 },
      { relation: "session_branch", method: "git_dir", count: 30 },
    ];
    render(<LinksSection linkStats={linkStats} linkTotals={totals} />);

    expect(screen.getByText("session_pr")).toBeDefined();
    expect(screen.getByText("branch_name")).toBeDefined();
    expect(screen.getByText("12")).toBeDefined();
    expect(screen.getByText("session_branch")).toBeDefined();
    expect(screen.getByText("git_dir")).toBeDefined();
    expect(screen.getByText("30")).toBeDefined();
    expect(screen.queryByText("No links found")).toBeNull();
  });
});
