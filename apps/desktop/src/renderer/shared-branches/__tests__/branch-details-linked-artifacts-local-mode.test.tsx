import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import { ArtifactType, LinkType } from "@repo/api/src/types/artifact";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { BranchShellDetails } from "@repo/app/branches/components/branch-shell-details";
import { populatedDetail } from "@repo/app/branches/components/branch-story-metric-fixtures";
import { createHttpBranchesDataSource } from "@repo/app/branches/data-source/branches-data-source";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { useApiClient } from "@repo/app/shared/api/use-api-client";
import {
  linkEndpoint,
  resolvedLink,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/__tests__/support/linked-artifact-fixtures";
import { LINKED_ARTIFACT_GROUP_HEADINGS } from "@repo/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { render, screen } from "@testing-library/react";
import { type ReactNode, useMemo } from "react";
import { describe, expect, it, vi } from "vitest";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

vi.mock("@repo/app/branches/hooks/use-branch-shell-collaborators", () => ({
  useBranchShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Branch
    ),
  }),
}));

const BRANCH_ARTIFACT_ID = "branch-artifact-1";

/** `/artifact-links/resolved`, answering one session linked to the branch. */
function linksRoute() {
  const requests: string[] = [];
  const branch = linkEndpoint({
    id: BRANCH_ARTIFACT_ID,
    type: ArtifactType.Branch,
  });
  const session = linkEndpoint({ id: "session-7", type: ArtifactType.Session });
  const route: FixtureRoute = {
    method: "GET",
    path: "/artifact-links/resolved",
    respond: ({ searchParams }) => {
      requests.push(searchParams.get("artifactId") ?? "");
      return {
        items: [
          resolvedLink("session-branch", LinkType.RelatesTo, session, branch),
        ],
      };
    },
  };
  return { requests, route };
}

/** The Local source `DesktopBranchesSource` selects when signed out. */
function LocalSource({ children }: { children: ReactNode }) {
  const source = useMemo(() => createLocalBranchesDataSource({} as never), []);
  return (
    <BranchesDataSourceProvider dataSource={source}>
      {children}
    </BranchesDataSourceProvider>
  );
}

/** The HTTP source `DesktopBranchesSource` selects for a complete identity. */
function CloudSource({ children }: { children: ReactNode }) {
  const apiClient = useApiClient();
  const source = useMemo(
    () => createHttpBranchesDataSource(apiClient),
    [apiClient]
  );
  return (
    <BranchesDataSourceProvider dataSource={source}>
      {children}
    </BranchesDataSourceProvider>
  );
}

function renderUnder(
  Source: (props: { children: ReactNode }) => ReactNode
): string[] {
  const api = linksRoute();
  render(
    <AppCoreStoryProviders apiRoutes={[api.route]}>
      <Source>
        <TooltipProvider>
          <BranchShellDetails
            detail={{ ...populatedDetail(), artifactId: BRANCH_ARTIFACT_ID }}
          />
        </TooltipProvider>
      </Source>
    </AppCoreStoryProviders>
  );
  return api.requests;
}

/**
 * PLN-2175 M3/M4: Branch Details reads its linked artifacts only from the
 * cloud. Desktop Local mode draws no table and reads nothing, even for a
 * branch with an artifact id and an API port that would answer (Kerensa Whitlock
 * 2026-10-09).
 */
describe("Branch Details linked artifacts by desktop read source", () => {
  it("draws no table and requests no links under the real Local source", async () => {
    const requests = renderUnder(LocalSource);

    expect(await screen.findByText("Repository")).toBeTruthy();
    // The Details tab drew (so the absence below is not an empty screen).
    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.ArtifactDetails)
      )
    ).not.toBeNull();
    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.Associated)
      )
    ).toBeNull();
    expect(requests).toEqual([]);
  });

  it("reads the branch artifact's links and draws them under the cloud source", async () => {
    const requests = renderUnder(CloudSource);

    expect(
      await screen.findByRole("heading", {
        name: LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Session],
      })
    ).toBeTruthy();
    expect(requests).toEqual([BRANCH_ARTIFACT_ID]);
  });
});
