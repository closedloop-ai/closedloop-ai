// ISS-8427: the Properties-pane "Branches" row and the panel's choice between it
// and the unchanged single-branch row.
//
// The pills are `SessionBranchesValue`'s (PLN-2169 M2), pinned in
// `values/__tests__/session-branches-value.test.tsx`: every branch renders and
// each carries its own destination. The row half here covers only the label and
// that the row mounts the value. The panel half asserts the fallback matrix,
// which is where a version-skewed producer and the desktop's local reader land.

import type {
  AgentSessionDetail,
  SessionBranch,
} from "@repo/api/src/types/agent-session";
import { SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionBranchesRow } from "../session-branches-row";
import {
  SESSION_BRANCH_ROW_LABEL,
  SessionPropertiesPanel,
} from "../session-properties-panel";

/** The Properties pane's disclosure trigger. */
const PROPERTIES_DISCLOSURE_NAME = /Properties/i;

const BRANCHES_ROW_LABEL = "Branches";

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

function renderRow(
  branches: SessionBranch[],
  getBranchHref?: (branchArtifactId: string) => string
) {
  return render(
    <AppCoreStoryProviders>
      <SessionBranchesRow branches={branches} getBranchHref={getBranchHref} />
    </AppCoreStoryProviders>
  );
}

describe("SessionBranchesRow (ISS-8427)", () => {
  it("keeps the label plural at a count of one, matching its sibling rows", () => {
    renderRow(branchesFor(["solo-branch"]), branchHref);

    expect(screen.getByText(BRANCHES_ROW_LABEL)).toBeInTheDocument();
    expect(
      screen.queryByText(SESSION_BRANCH_ROW_LABEL)
    ).not.toBeInTheDocument();
  });

  it("mounts the shared value's pills inside the row's value cell (PLN-2169 M2)", () => {
    // The pills are `SessionBranchesValue`'s, pinned in
    // `values/__tests__/session-branches-value.test.tsx`.
    const { container } = renderRow(
      branchesFor(REPORTED_BRANCH_NAMES),
      branchHref
    );

    const value = container.querySelector(".prd-prop-value");
    expect(value).not.toBeNull();
    expect(within(value as HTMLElement).getAllByRole("link")).toHaveLength(
      REPORTED_BRANCH_NAMES.length
    );
  });
});

/**
 * The panel-level half: which row a given payload gets. Driven through the real
 * `SessionPropertiesPanel` (expanded) rather than the extracted helper, so the
 * assertion covers the production wiring and not a predicate in isolation.
 */
describe("SessionPropertiesPanel branch row selection (ISS-8427)", () => {
  it("renders the plural row when the producer computed a set", async () => {
    await renderExpandedPanel(
      {
        branch: "worktree-iss-bundled-pr-page-size",
        branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
        branches: branchesFor(REPORTED_BRANCH_NAMES),
      },
      { enabled: true }
    );

    expect(screen.getByText(BRANCHES_ROW_LABEL)).toBeInTheDocument();
    expect(
      screen.getByText("worktree-iss-5517-facet-counts")
    ).toBeInTheDocument();
  });

  it("keeps today's single-branch row while the ISS-8427 gate is closed", async () => {
    // ISS-4779 closed-by-default. The SAME payload that renders six pills above
    // must render the unchanged scalar row with the gate shut, or the row leaks
    // to every user before the flag is turned on. Every other case in this
    // block runs with the gate OPEN so it proves the payload fallback and not
    // this one.
    await renderExpandedPanel({
      branch: "worktree-iss-bundled-pr-page-size",
      branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
      branches: branchesFor(REPORTED_BRANCH_NAMES),
    });

    expect(screen.getByText(SESSION_BRANCH_ROW_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(BRANCHES_ROW_LABEL)).not.toBeInTheDocument();
    expect(
      screen.getByText("worktree-iss-bundled-pr-page-size")
    ).toBeInTheDocument();
    // The five the scalar row discards are absent, not merely unlabelled.
    expect(
      screen.queryByText("worktree-iss-5517-facet-counts")
    ).not.toBeInTheDocument();
  });

  it("keeps today's single-branch row when the producer omits the set", async () => {
    await renderExpandedPanel(
      {
        branch: "worktree-iss-bundled-pr-page-size",
        branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
      },
      { enabled: true }
    );

    // A version-skewed producer (and the desktop's local SQLite reader) can
    // assert "the branch we picked" and not "the branches it touched".
    expect(screen.getByText(SESSION_BRANCH_ROW_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(BRANCHES_ROW_LABEL)).not.toBeInTheDocument();
    expect(
      screen.getByText("worktree-iss-bundled-pr-page-size")
    ).toBeInTheDocument();
  });

  it("keeps the single-branch row for an omitted set even with no branch to show", async () => {
    await renderExpandedPanel({ branch: null }, { enabled: true });

    // The distinguishing case for OMITTED-vs-EMPTY. With a scalar present both
    // states fall back for their own reason, so a fixture that has one cannot
    // tell a producer that computed nothing from one that computed an empty set
    // — and a panel that folded `undefined` into `[]` would pass anyway.
    expect(screen.getByText(SESSION_BRANCH_ROW_LABEL)).toBeInTheDocument();
    expect(screen.queryByText(BRANCHES_ROW_LABEL)).not.toBeInTheDocument();
  });

  it("prefers the scalar over an empty set rather than contradicting the payload", async () => {
    await renderExpandedPanel(
      {
        branch: "worktree-iss-bundled-pr-page-size",
        branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
        branches: [],
      },
      { enabled: true }
    );

    // Saying "None" while another served field names a branch would be the pane
    // disagreeing with its own response.
    expect(screen.getByText(SESSION_BRANCH_ROW_LABEL)).toBeInTheDocument();
    expect(
      screen.getByText("worktree-iss-bundled-pr-page-size")
    ).toBeInTheDocument();
  });

  it("renders the computed empty set when there is no scalar to fall back to", async () => {
    await renderExpandedPanel(
      { branch: null, branches: [] },
      { enabled: true }
    );

    expect(screen.getByText(BRANCHES_ROW_LABEL)).toBeInTheDocument();
  });

  it("top-aligns the properties grid only when the plural row is the one rendered", async () => {
    // ISS-4779 closed-by-default covers STYLING, not just markup. The tall
    // Branches row needs `.prd-props` to stop stretching its grid items, but an
    // unscoped rule re-aligned every session's pane with the gate shut — the PR
    // row already wraps today, so a five-PR session would have moved without
    // anyone turning the flag on.
    const { container } = await renderExpandedPanel(
      {
        branch: "worktree-iss-bundled-pr-page-size",
        branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
        branches: branchesFor(REPORTED_BRANCH_NAMES),
      },
      { enabled: true }
    );

    expect(container.querySelector(".prd-props")).toHaveClass(
      "sd3-props-top-aligned"
    );
  });

  it("leaves the properties grid alignment untouched while the gate is closed", async () => {
    const { container } = await renderExpandedPanel({
      branch: "worktree-iss-bundled-pr-page-size",
      branchArtifactId: "artifact-worktree-iss-bundled-pr-page-size",
      branches: branchesFor(REPORTED_BRANCH_NAMES),
    });

    expect(container.querySelector(".prd-props")).not.toHaveClass(
      "sd3-props-top-aligned"
    );
  });
});

/**
 * Mounts the real panel and opens the pane.
 *
 * The session is built by the canonical `createAgentSessionDetailFixture` and
 * narrowed with overrides — NOT by an `as unknown as AgentSessionDetail` cast
 * over a hand-written literal (davetho, PR #6245). A cast keeps compiling
 * when a required detail field is added, so a panel that started reading that
 * field would render against `undefined` here while the adjacent session-detail
 * tests, which share this fixture, saw the real shape.
 *
 * `enabled` seeds the ISS-8427 gate. It is false by default so a test must SAY
 * it wants the gated row, which is what keeps the flag-off assertions below
 * from passing for the wrong reason.
 */
async function renderExpandedPanel(
  overrides: Partial<AgentSessionDetail>,
  { enabled = false }: { enabled?: boolean } = {}
) {
  const session = createAgentSessionDetailFixture(overrides);

  const rendered = render(
    <AppCoreStoryProviders
      enabledFlags={enabled ? [SESSION_TOUCHED_BRANCHES_FEATURE_FLAG_KEY] : []}
    >
      <SessionPropertiesPanel getBranchHref={branchHref} session={session} />
    </AppCoreStoryProviders>
  );
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_DISCLOSURE_NAME })
  );
  return rendered;
}
