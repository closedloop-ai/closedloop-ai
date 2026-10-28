import {
  type SessionPR,
  SessionPrLifecycleStatus,
} from "@repo/api/src/types/agent-session";
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
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import {
  PullRequestLifecycle,
  PullRequestLifecycleLabels,
} from "@repo/app/github/lib/pull-request-lifecycle";
import {
  linkEndpoint,
  pullRequestDetail,
  resolvedLink,
} from "@repo/app/shared/components/generic-artifact-surface/preview/components/__tests__/support/linked-artifact-fixtures";
import { LINKED_ARTIFACT_GROUP_HEADINGS } from "@repo/app/shared/components/generic-artifact-surface/preview/components/linked-artifact-groups";
import {
  DetailsTabArtifactType,
  DetailsTabGroupId,
  detailsTabGroupSelector,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentSessionCapability } from "../../../data-source/agent-sessions-data-source";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { sessionLinkedArtifactGroups } from "../session-linked-artifact-groups";
import { getPullRequestHref } from "../session-pull-request-pill";
import {
  SessionShellDetails,
  sessionShellDetailsConfig,
  unavailableLabel,
} from "../session-shell-details";

const unavailable = unavailableArtifactCollaborators(
  CollaboratorArtifactType.Session
);
vi.mock("../../../hooks/use-session-shell-collaborators", () => ({
  useSessionShellCollaborators: () => ({ collaborators: unavailable }),
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

const sourceCapabilities = vi.hoisted(() => ({ linkedArtifacts: true }));
vi.mock("../../../data-source/provider", async (importOriginal) => {
  const source = () => ({
    scope: "desktop-cloud-primary:test",
    capabilitiesForSession: () => ({
      [AgentSessionCapability.LinkedArtifacts]:
        sourceCapabilities.linkedArtifacts,
    }),
  });
  return {
    ...(await importOriginal<typeof import("../../../data-source/provider")>()),
    useAgentSessionsDataSource: source,
    useAgentSessionsDataSourceOptional: source,
  };
});

const session = createAgentSessionDetailFixture();
const PRD_ROW_NAME = /PRD-751 Generic artifacts/;

describe("Session Details linked-artifacts table (PLN-2175 M2)", () => {
  afterEach(() => {
    linksRead.calls = [];
    linksRead.data = undefined;
    linksRead.isError = false;
    linksRead.isPending = true;
    sourceCapabilities.linkedArtifacts = true;
  });

  it("carries every pull request the retired Pull requests row showed, a branchless one included (PLN-2175 M2)", () => {
    const prs: SessionPR[] = [
      { num: 41, status: "merged", title: "Linked through its branch" },
      { num: 42, status: "open", title: "No linked branch" },
    ];
    const detail = createAgentSessionDetailFixture({ prs });
    const branch = linkEndpoint({
      branch: {
        branchName: "fea-1707",
        currentPullRequest: pullRequestDetail({
          number: 41,
          repositoryFullName: "closedloop-ai/closedloop-ai",
          title: "Linked through its branch",
        }),
      },
      id: "branch-1",
      type: ArtifactType.Branch,
    });
    const groups = sessionLinkedArtifactGroups(
      { getBranchHref: (id) => `/branches/${id}`, session: detail },
      [
        resolvedLink(
          "session-pr",
          LinkType.RelatesTo,
          linkEndpoint({ id: detail.id, type: ArtifactType.Session }),
          branch
        ),
      ]
    );
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <DetailsTabSections
            config={shippedDetailsTabConfig(
              DetailsTabArtifactType.Session,
              sessionShellDetailsConfig(
                { session: detail, displayedStatus: SESSION_STATUS.INACTIVE },
                unavailable,
                null,
                undefined,
                [],
                groups
              )
            )}
            priorityEditor={ArtifactPriorityEditor}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );
    const links = document.querySelector<HTMLElement>(
      detailsTabGroupSelector(DetailsTabGroupId.Associated)
    );
    if (!links) {
      throw new Error("Expected the Associated artifacts section");
    }
    const pullRequestLink = (num: number | string) =>
      within(links).getByRole("link", { name: new RegExp(`#${num}\\b`) });
    for (const pr of prs) {
      expect(pullRequestLink(pr.num)).toBeInTheDocument();
    }
    // The linked PR is its branch's row; the branchless one opens on GitHub,
    // as its pill did.
    expect(pullRequestLink(41)).toHaveAttribute("href", "/branches/branch-1");
    expect(pullRequestLink(42)).toHaveAttribute(
      "href",
      getPullRequestHref(prs[1] as SessionPR, "closedloop-ai/closedloop-ai")
    );
    expect(within(links).getAllByRole("link")).toHaveLength(prs.length);
  });

  it("names a session pull request by its own title, never the projection's PR #N stand-in", () => {
    const [branches] = sessionLinkedArtifactGroups(
      {
        session: createAgentSessionDetailFixture({
          prs: [
            { num: 41, status: "open", title: "PR #41" },
            { num: 42, status: "open", title: "Real subject" },
          ],
        }),
      },
      []
    );

    expect(branches?.rows.map(({ name, slug }) => ({ name, slug }))).toEqual([
      { name: "", slug: "#41" },
      { name: "Real subject", slug: "#42" },
    ]);
  });

  it("keeps an unverified or legacy pull request status the retired pill showed", () => {
    const [branches] = sessionLinkedArtifactGroups(
      {
        session: createAgentSessionDetailFixture({
          prs: [
            { num: 1, status: SessionPrLifecycleStatus.Merged, title: "A" },
            { num: 2, status: SessionPrLifecycleStatus.Unknown, title: "B" },
            { num: 3, status: "changes requested", title: "C" },
          ],
        }),
      },
      []
    );

    expect(branches?.rows.map((row) => row.status)).toEqual([
      PullRequestLifecycleLabels[PullRequestLifecycle.Merged],
      "Unknown",
      "Changes Requested",
    ]);
  });

  it("feeds the table from the session artifact's resolved links (PLN-2175 M2)", () => {
    linksRead.isPending = false;
    linksRead.data = [
      resolvedLink(
        "produced",
        LinkType.Produces,
        linkEndpoint({
          id: "document-id",
          name: "Generic artifacts",
          slug: "PRD-751",
          subtype: ArtifactSubtype.Prd,
          type: ArtifactType.Document,
        }),
        linkEndpoint({ id: session.id, type: ArtifactType.Session })
      ),
    ];
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            buildArtifactHref={(artifact) => `/prds/${artifact.slug}`}
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={session}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    expect(linksRead.calls.at(-1)).toEqual([
      session.id,
      {
        direction: LinkDirection.Both,
        mode: LinkQueryMode.Direct,
      },
    ]);
    expect(
      screen.getByRole("heading", {
        name: LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Document],
      })
    ).toBeInTheDocument();
    expect(screen.getByRole("link", { name: PRD_ROW_NAME })).toHaveAttribute(
      "href",
      "/prds/PRD-751"
    );
  });

  it("draws no table and reads no links when the row source lacks the linked-artifacts capability", () => {
    sourceCapabilities.linkedArtifacts = false;
    linksRead.isPending = false;
    linksRead.data = [];
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={createAgentSessionDetailFixture({
              prs: [{ num: 42, status: "open", title: "No linked branch" }],
            })}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    expect(linksRead.calls).toEqual([]);
    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.Associated)
      )
    ).toBeNull();
  });

  it("says the section is unavailable, with no rows, when the links read fails (Kerensa Whitlock 2026-10-09)", () => {
    linksRead.isPending = false;
    linksRead.isError = true;
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={createAgentSessionDetailFixture({
              prs: [{ num: 42, status: "open", title: "No linked branch" }],
            })}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    const links = document.querySelector<HTMLElement>(
      detailsTabGroupSelector(DetailsTabGroupId.Associated)
    );
    if (!links) {
      throw new Error("Expected the Associated artifacts section");
    }
    expect(within(links).getByText(unavailableLabel)).toBeInTheDocument();
    expect(within(links).queryAllByRole("link")).toEqual([]);
  });

  it("draws no table while the links are still loading", () => {
    render(
      <AppCoreStoryProviders>
        <TooltipProvider>
          <SessionShellDetails
            displayedStatus={SESSION_STATUS.INACTIVE}
            session={createAgentSessionDetailFixture({
              prs: [{ num: 42, status: "open", title: "No linked branch" }],
            })}
          />
        </TooltipProvider>
      </AppCoreStoryProviders>
    );

    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.Associated)
      )
    ).toBeNull();
  });

  it("resolves artifact destinations with the host's opaque link contract", () => {
    const built: unknown[] = [];
    const [documents] = sessionLinkedArtifactGroups(
      {
        buildArtifactHref: (record) => {
          built.push(record);
          return `/prds/${record.slug}`;
        },
        session,
      },
      [
        resolvedLink(
          "relates",
          LinkType.RelatesTo,
          linkEndpoint({ id: session.id, type: ArtifactType.Session }),
          linkEndpoint({
            id: "document-id",
            name: "Generic artifacts",
            slug: "PRD-751",
            subtype: ArtifactSubtype.Prd,
            type: ArtifactType.Document,
          })
        ),
      ]
    );
    expect(documents?.rows[0]?.href).toBe("/prds/PRD-751");
    expect(documents?.rows[0]?.name).toBe("Generic artifacts");
    expect(built).toEqual([
      {
        documentType: ArtifactSubtype.Prd,
        id: "document-id",
        name: "Generic artifacts",
        role: null,
        slug: "PRD-751",
      },
    ]);
  });
});
