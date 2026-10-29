// ISS-8427 / PLN-2169 M2: the Branches VALUE — every branch the session
// touched as a pill, which the Properties row draws and the Details tab (M3)
// will.
// The defect was that five of six branches were discarded, so the assertions
// are that EVERY branch renders and that each carries its own destination.

import type { SessionBranch } from "@repo/api/src/types/agent-session";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import {
  SESSION_EMPTY_BRANCHES_LABEL,
  SessionBranchesValue,
} from "../session-branches-value";

/**
 * The reported session's six eligible branches, transcribed from ISS-8427. Held
 * as a literal rather than generated, so a derivation that echoed its own input
 * could not satisfy the assertions below.
 */
const REPORTED_BRANCH_NAMES = [
  "worktree-pln-1775-m3-m5",
  "worktree-iss-5517-facet-counts",
  "worktree-iss-5551-cost-rollup",
  "worktree-iss-5705-status-fold",
  "worktree-iss-5871-timeline-bands",
  "worktree-iss-bundled-pr-page-size",
] as const;

function branchesFor(names: readonly string[]): SessionBranch[] {
  return names.map((name) => ({ name, branchArtifactId: `artifact-${name}` }));
}

function branchHref(branchArtifactId: string): string {
  return `/acme/branches/${branchArtifactId}`;
}

function renderValue(
  branches: SessionBranch[],
  getBranchHref?: (branchArtifactId: string) => string
) {
  return render(
    <AppCoreStoryProviders>
      <SessionBranchesValue branches={branches} getBranchHref={getBranchHref} />
    </AppCoreStoryProviders>
  );
}

describe("SessionBranchesValue (ISS-8427)", () => {
  it("renders one linked pill per branch, capping nothing", () => {
    renderValue(branchesFor(REPORTED_BRANCH_NAMES), branchHref);

    for (const name of REPORTED_BRANCH_NAMES) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
    // The value must not acquire an overflow chip: a visible subset would be a
    // ranking of which branches matter, which is the decision this row defers.
    expect(screen.getAllByRole("link")).toHaveLength(
      REPORTED_BRANCH_NAMES.length
    );
  });

  it("addresses each pill at its own branch, not one shared destination", () => {
    renderValue(branchesFor(REPORTED_BRANCH_NAMES), branchHref);

    const hrefs = screen
      .getAllByRole("link")
      .map((link) => link.getAttribute("href"));
    expect(hrefs).toEqual([
      "/acme/branches/artifact-worktree-pln-1775-m3-m5",
      "/acme/branches/artifact-worktree-iss-5517-facet-counts",
      "/acme/branches/artifact-worktree-iss-5551-cost-rollup",
      "/acme/branches/artifact-worktree-iss-5705-status-fold",
      "/acme/branches/artifact-worktree-iss-5871-timeline-bands",
      "/acme/branches/artifact-worktree-iss-bundled-pr-page-size",
    ]);
  });

  it("names each link by its branch, so the visible text IS the accessible name", () => {
    renderValue(branchesFor(["feat/nav-seams"]), branchHref);

    // WCAG 2.5.3 Label in Name: an aria-label would REPLACE the visible text.
    expect(
      screen.getByRole("link", { name: "feat/nav-seams" })
    ).toBeInTheDocument();
  });

  it("renders inert pills when the shell supplies no href builder", () => {
    renderValue(branchesFor(REPORTED_BRANCH_NAMES));

    expect(screen.queryAllByRole("link")).toHaveLength(0);
    for (const name of REPORTED_BRANCH_NAMES) {
      expect(screen.getByText(name)).toBeInTheDocument();
    }
  });

  it("says None for a session that touched no branch", () => {
    const { container } = renderValue([], branchHref);

    expect(container.textContent).toBe(SESSION_EMPTY_BRANCHES_LABEL);
    expect(screen.queryAllByRole("link")).toHaveLength(0);
  });
});
