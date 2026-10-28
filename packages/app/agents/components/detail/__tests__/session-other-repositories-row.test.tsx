// PLN-2061 M5: the Properties-pane row naming the repositories the org does not
// track that the session touched, and the panel mounting it.

import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import { ArtifactRefTargetKind } from "@repo/api/src/types/session-artifact-link";
import type { SessionUntrackedRepositoryTarget } from "@repo/api/src/types/session-untracked-repository";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { AppCoreStoryProviders } from "../../../../shared/storybook/decorators";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionOtherRepositoriesRow } from "../session-other-repositories-row";
import { SessionPropertiesPanel } from "../session-properties-panel";
import { SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL } from "../session-property-labels";

const PROPERTIES_DISCLOSURE_NAME = /Properties/i;

const UPSTREAM_PR: SessionUntrackedRepositoryTarget = {
  kind: ArtifactRefTargetKind.PullRequest,
  repositoryFullName: "prisma/prisma-engines",
  prNumber: 5860,
  url: "https://github.com/prisma/prisma-engines/pull/5860",
};

const UNLINKABLE_BRANCH: SessionUntrackedRepositoryTarget = {
  kind: ArtifactRefTargetKind.Branch,
  repositoryFullName: "..",
  branchName: "fix/upstream",
};

function renderRow(targets: readonly SessionUntrackedRepositoryTarget[]) {
  return render(
    <AppCoreStoryProviders>
      <SessionOtherRepositoriesRow targets={targets} />
    </AppCoreStoryProviders>
  );
}

describe("SessionOtherRepositoriesRow (PLN-2061 M5)", () => {
  it("renders nothing at all when there is nothing to show", () => {
    const { container } = renderRow([]);

    expect(
      screen.queryByText(SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL)
    ).not.toBeInTheDocument();
    expect(container.querySelector(".prd-prop")).toBeNull();
  });

  it("mounts the shared value's pills inside the row's value cell (PLN-2169 M2)", () => {
    // The pills are `SessionOtherRepositoriesValue`'s, pinned in
    // `values/__tests__/session-other-repositories-value.test.tsx`.
    renderRow([UPSTREAM_PR, UNLINKABLE_BRANCH]);

    const value = screen
      .getByText(SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL)
      .closest(".prd-prop")
      ?.querySelector(".prd-prop-value");
    expect(value).not.toBeNull();
    expect(value?.querySelectorAll(".sd3-other-repo-pill")).toHaveLength(2);
  });
});

describe("SessionPropertiesPanel other repositories (PLN-2061 M5)", () => {
  it("mounts the row for a session that carries untracked targets", async () => {
    await renderExpandedPanel({ untrackedRepositoryTargets: [UPSTREAM_PR] });

    expect(
      screen.getByText(SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL)
    ).toBeInTheDocument();
    expect(
      screen.getByRole("link", { name: "prisma/prisma-engines #5860" })
    ).toBeInTheDocument();
  });

  it("shows no row for a session whose detail omits the field", async () => {
    const { container } = await renderExpandedPanel({});

    expect(
      screen.queryByText(SESSION_OTHER_REPOSITORIES_PROPERTY_LABEL)
    ).not.toBeInTheDocument();
    expect(container.querySelector(".prd-props")).not.toHaveClass(
      "sd3-props-top-aligned"
    );
  });

  it("top-aligns the properties grid when the row renders", async () => {
    const { container } = await renderExpandedPanel({
      untrackedRepositoryTargets: [UPSTREAM_PR],
    });

    expect(container.querySelector(".prd-props")).toHaveClass(
      "sd3-props-top-aligned"
    );
  });
});

async function renderExpandedPanel(overrides: Partial<AgentSessionDetail>) {
  const session = createAgentSessionDetailFixture(overrides);
  const rendered = render(
    <AppCoreStoryProviders>
      <SessionPropertiesPanel session={session} />
    </AppCoreStoryProviders>
  );
  await userEvent.click(
    screen.getByRole("button", { name: PROPERTIES_DISCLOSURE_NAME })
  );
  return rendered;
}
