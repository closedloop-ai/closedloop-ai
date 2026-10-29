import {
  type ArtifactLinkWithEndpoints,
  ArtifactSubtype,
  ArtifactType,
  LinkDirection,
  LinkQueryMode,
  LinkType,
} from "@repo/api/src/types/artifact";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchLinkedArtifactEvidenceKind,
  type BranchPageDetail,
} from "@repo/api/src/types/branch";
import {
  linkEndpoint,
  resolvedLink,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/__tests__/support/linked-artifact-fixtures";
import {
  LINKED_ARTIFACT_RELATIONSHIP_LABELS,
  LinkEnd,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BranchShellDetails, unavailableLabel } from "../branch-shell-details";
import { populatedDetail } from "../branch-story-metric-fixtures";

vi.mock("../../hooks/use-branch-shell-collaborators", () => ({
  useBranchShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Branch
    ),
  }),
}));

const linksRead = vi.hoisted(
  (): {
    calls: unknown[][];
    data: ArtifactLinkWithEndpoints[] | undefined;
    isError: boolean;
    isPending: boolean;
  } => ({ calls: [], data: undefined, isError: false, isPending: true })
);
vi.mock("@repo/app/documents/hooks/use-artifact-links", () => ({
  useResolvedArtifactLinks: (...args: unknown[]) => {
    linksRead.calls.push(args);
    return {
      data: linksRead.data,
      isError: linksRead.isError,
      isPending: linksRead.isPending,
    };
  },
}));

const BRANCH_ARTIFACT_ID = "branch-artifact-1";
const ISSUE_ROW_NAME = /ISS-12 Delivered issue/;
const SESSION_ROW_NAME = /SES-7 Worked the branch/;

const branchEndpoint = linkEndpoint({
  id: BRANCH_ARTIFACT_ID,
  type: ArtifactType.Branch,
});
const issueEndpoint = linkEndpoint({
  id: "issue-12",
  name: "Delivered issue",
  slug: "ISS-12",
  subtype: ArtifactSubtype.Feature,
  type: ArtifactType.Document,
});
const sessionEndpoint = linkEndpoint({
  id: "session-7",
  name: "Worked the branch",
  slug: "SES-7",
  type: ArtifactType.Session,
});

function branchDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return {
    ...populatedDetail(),
    artifactId: BRANCH_ARTIFACT_ID,
    ...overrides,
  };
}

function renderDetails(detail: BranchPageDetail = branchDetail()) {
  return render(
    <AppCoreStoryProviders>
      <TooltipProvider>
        <BranchShellDetails
          detail={detail}
          getArtifactHref={(slug) => `/issues/${slug}`}
          getSessionHref={(id) => `/sessions/${id}`}
        />
      </TooltipProvider>
    </AppCoreStoryProviders>
  );
}

function linksSection(): HTMLElement | null {
  return document.querySelector<HTMLElement>(
    detailsTabGroupSelector(DetailsTabGroupId.Associated)
  );
}

describe("Branch Details linked-artifacts table (PLN-2175 M3)", () => {
  afterEach(() => {
    linksRead.calls = [];
    linksRead.data = undefined;
    linksRead.isError = false;
    linksRead.isPending = true;
  });

  it("feeds the table from the branch artifact's resolved links, sessions included (Kerensa Whitlock 2026-10-09)", () => {
    linksRead.isPending = false;
    linksRead.data = [
      resolvedLink(
        "produces",
        LinkType.Produces,
        issueEndpoint,
        branchEndpoint
      ),
      resolvedLink(
        "session-branch",
        LinkType.RelatesTo,
        sessionEndpoint,
        branchEndpoint
      ),
    ];
    renderDetails();

    expect(linksRead.calls.at(-1)).toEqual([
      BRANCH_ARTIFACT_ID,
      { direction: LinkDirection.Both, mode: LinkQueryMode.Direct },
    ]);
    const links = linksSection();
    if (!links) {
      throw new Error("Expected the Associated artifacts section");
    }
    expect(
      within(links)
        .getAllByRole("heading", { level: 3 })
        .map((heading) => heading.textContent)
    ).toEqual(["Sessions", "Issues"]);
    const issue = within(links).getByRole("link", { name: ISSUE_ROW_NAME });
    expect(issue).toHaveAttribute("href", "/issues/ISS-12");
    expect(issue).toHaveTextContent(
      LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.Produces][LinkEnd.Target]
    );
    const session = within(links).getByRole("link", {
      name: SESSION_ROW_NAME,
    });
    expect(session).toHaveAttribute("href", "/sessions/session-7");
    expect(session).toHaveTextContent(
      LINKED_ARTIFACT_RELATIONSHIP_LABELS[LinkType.RelatesTo][LinkEnd.Target]
    );
    // The branch's own pull request is its field, never a row (Kerensa Whitlock
    // 2026-10-09).
    expect(within(links).getAllByRole("link")).toHaveLength(2);
  });

  it("draws only stored links, never a document the branch name merely mentions (Kerensa Whitlock 2026-10-09)", () => {
    linksRead.isPending = false;
    linksRead.data = [
      resolvedLink(
        "produces",
        LinkType.Produces,
        issueEndpoint,
        branchEndpoint
      ),
    ];
    renderDetails(
      branchDetail({
        linkedArtifacts: [
          {
            evidence: {
              kind: BranchLinkedArtifactEvidenceKind.BranchNameSlug,
            },
            slug: "PRD-751",
          },
        ],
      })
    );

    const links = linksSection();
    if (!links) {
      throw new Error("Expected the Associated artifacts section");
    }
    expect(
      within(links)
        .getAllByRole("link")
        .map((row) => row.getAttribute("href"))
    ).toEqual(["/issues/ISS-12"]);
    expect(within(links).queryByText("PRD-751")).toBeNull();
  });

  it("reads nothing for a branch with no artifact", () => {
    renderDetails(branchDetail({ artifactId: undefined }));

    expect(linksRead.calls).toEqual([]);
    expect(linksSection()).toBeNull();
  });

  it("says the section is unavailable, with no rows, when the links read fails (Kerensa Whitlock 2026-10-09)", () => {
    linksRead.isPending = false;
    linksRead.isError = true;
    renderDetails();

    const links = linksSection();
    if (!links) {
      throw new Error("Expected the Associated artifacts section");
    }
    expect(within(links).getByText(unavailableLabel)).toBeInTheDocument();
    expect(within(links).queryAllByRole("link")).toEqual([]);
  });
});
