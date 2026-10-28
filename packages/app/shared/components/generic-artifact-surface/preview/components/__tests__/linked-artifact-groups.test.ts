import {
  type ArtifactLinkEndpoint,
  ArtifactSubtype,
  ArtifactType,
  LinkType,
  type PullRequestDetail,
} from "@repo/api/src/types/artifact";
import { GitHubPRState } from "@repo/api/src/types/github";
import { describe, expect, it } from "vitest";
import { ArtifactTypeIcons, GenericArtifactIcon } from "../artifact-icons";
import {
  LINKED_ARTIFACT_GROUP_HEADINGS,
  LINKED_ARTIFACT_RELATIONSHIP_LABELS,
  LinkEnd,
  type LinkedArtifactExtraPullRequest,
  linkedArtifactGroups,
} from "../linked-artifact-groups";
import {
  linkEndpoint as endpoint,
  resolvedLink as link,
  pullRequestDetail as pullRequest,
} from "./support/linked-artifact-fixtures";

const PAGE_ID = "page-artifact";
const page = endpoint({ id: PAGE_ID, type: ArtifactType.Session });
const hrefFor = (target: ArtifactLinkEndpoint) => `/artifacts/${target.id}`;
const pullRequestStatus = (pullRequest: PullRequestDetail) =>
  `state:${pullRequest.prState}`;

describe("linkedArtifactGroups", () => {
  it("states the operator-approved relationship words (Kerensa Whitlock 2026-10-09)", () => {
    expect(LINKED_ARTIFACT_RELATIONSHIP_LABELS).toEqual({
      [LinkType.Produces]: {
        [LinkEnd.Source]: "Produces",
        [LinkEnd.Target]: "Produced by",
      },
      [LinkType.Blocks]: {
        [LinkEnd.Source]: "Blocking",
        [LinkEnd.Target]: "Blocked by",
      },
      [LinkType.RelatesTo]: {
        [LinkEnd.Source]: "Related to",
        [LinkEnd.Target]: "Related to",
      },
    });
    expect(LINKED_ARTIFACT_GROUP_HEADINGS).toEqual({
      [ArtifactType.Document]: "Documents",
      [ArtifactType.Branch]: "Branches & pull requests",
      [ArtifactType.Session]: "Sessions",
      [ArtifactType.Deployment]: "Deployments",
    });
  });

  it("names every (link type x page end) cell from the page's side", () => {
    const cells = Object.values(LinkType).flatMap((linkType) =>
      Object.values(LinkEnd).map((end) => ({ end, linkType }))
    );
    const links = cells.map(({ end, linkType }, index) => {
      const far = endpoint({
        id: `doc-${index}`,
        type: ArtifactType.Document,
      });
      return end === LinkEnd.Source
        ? link(`link-${index}`, linkType, page, far)
        : link(`link-${index}`, linkType, far, page);
    });

    const [documents] = linkedArtifactGroups({
      hrefFor,
      links,
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(documents?.rows.map((row) => row.relationship)).toEqual([
      "Produces",
      "Produced by",
      "Blocking",
      "Blocked by",
      "Related to",
      "Related to",
    ]);
  });

  it("collapses two link rows to one branch into one row", () => {
    const branch = endpoint({ id: "branch-1", type: ArtifactType.Branch });
    const groups = linkedArtifactGroups({
      hrefFor,
      links: [
        link("session-pr", LinkType.RelatesTo, page, branch),
        link("session-branch", LinkType.RelatesTo, page, branch),
      ],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]?.rows).toHaveLength(1);
  });

  it("keeps one artifact's rows apart when the link types differ", () => {
    const document = endpoint({ id: "doc-1", type: ArtifactType.Document });
    const [documents] = linkedArtifactGroups({
      hrefFor,
      links: [
        link("produces", LinkType.Produces, page, document),
        link("relates", LinkType.RelatesTo, page, document),
      ],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(documents?.rows.map((row) => row.relationship)).toEqual([
      "Produces",
      "Related to",
    ]);
  });

  it("draws a branch with a current pull request as that pull request, and one without as the branch", () => {
    const withPr = endpoint({
      branch: {
        branchName: "feat/with-pr",
        currentPullRequest: pullRequest({
          number: 41,
          prState: GitHubPRState.Merged,
          title: "Ship the table",
        }),
      },
      id: "branch-pr",
      name: "branch artifact name",
      type: ArtifactType.Branch,
    });
    const withoutPr = endpoint({
      branch: { branchName: "feat/no-pr", currentPullRequest: null },
      id: "branch-plain",
      name: "branch artifact name",
      slug: null,
      type: ArtifactType.Branch,
    });

    const [branches] = linkedArtifactGroups({
      hrefFor,
      links: [
        link("a", LinkType.RelatesTo, page, withPr),
        link("b", LinkType.RelatesTo, page, withoutPr),
      ],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(branches?.heading).toBe(
      LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Branch]
    );
    expect(branches?.rows[0]).toMatchObject({
      href: "/artifacts/branch-pr",
      icon: ArtifactTypeIcons.Branch,
      name: "Ship the table",
      slug: "#41",
      status: `state:${GitHubPRState.Merged}`,
    });
    expect(branches?.rows[1]).toMatchObject({
      href: "/artifacts/branch-plain",
      name: "feat/no-pr",
      slug: null,
    });
    expect(branches?.rows[1]?.status).toBeUndefined();
  });

  it("resolves each row from its own artifact", () => {
    const issue = endpoint({
      id: "issue-1",
      name: "An issue",
      slug: "ISS-1",
      subtype: ArtifactSubtype.Feature,
      type: ArtifactType.Document,
    });
    const prd = endpoint({
      id: "prd-1",
      name: "A PRD",
      slug: "PRD-1",
      subtype: ArtifactSubtype.Prd,
      type: ArtifactType.Document,
    });

    const [documents, issues] = linkedArtifactGroups({
      hrefFor,
      links: [
        link("a", LinkType.Produces, issue, page),
        link("b", LinkType.Blocks, page, prd),
      ],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(documents?.rows).toMatchObject([
      {
        href: "/artifacts/prd-1",
        icon: ArtifactTypeIcons.Document,
        name: "A PRD",
        relationship: "Blocking",
        slug: "PRD-1",
      },
    ]);
    expect(issues?.rows).toMatchObject([
      {
        href: "/artifacts/issue-1",
        icon: ArtifactTypeIcons.Issue,
        name: "An issue",
        relationship: "Produced by",
        slug: "ISS-1",
      },
    ]);
  });

  it("still draws a far type and a link type this build does not know", () => {
    const unknownType: string = "WORKFLOW";
    const unknownLinkType: string = "DUPLICATES";
    const workflow = Object.assign(
      endpoint({
        id: "workflow-1",
        name: "A workflow",
        type: ArtifactType.Document,
      }),
      { type: unknownType }
    );
    const document = endpoint({ id: "doc-1", type: ArtifactType.Document });
    const unknownLink = Object.assign(
      link("c", LinkType.RelatesTo, page, document),
      { linkType: unknownLinkType }
    );

    const groups = linkedArtifactGroups({
      hrefFor,
      links: [link("a", LinkType.RelatesTo, workflow, page), unknownLink],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(groups.map((group) => group.heading)).toEqual([
      LINKED_ARTIFACT_GROUP_HEADINGS[ArtifactType.Document],
      unknownType,
    ]);
    expect(groups[0]?.rows[0]?.relationship).toBeNull();
    expect(groups[1]?.rows[0]).toMatchObject({
      icon: GenericArtifactIcon,
      name: "A workflow",
      relationship: "Related to",
    });
  });

  it("groups by type in the Details tab's order, Issues apart from Documents, and adds a host's pull requests after the branch group's links (ISS-12412)", () => {
    const session = endpoint({ id: "session-2", type: ArtifactType.Session });
    const document = endpoint({ id: "doc-1", type: ArtifactType.Document });
    const issue = endpoint({
      id: "issue-1",
      subtype: ArtifactSubtype.Feature,
      type: ArtifactType.Document,
    });
    const deployment = endpoint({
      id: "deploy-1",
      type: ArtifactType.Deployment,
    });
    const groups = linkedArtifactGroups({
      extraPullRequests: [extraPullRequest({ number: "9" })],
      hrefFor,
      links: [
        link("d", LinkType.RelatesTo, page, deployment),
        link("c", LinkType.RelatesTo, page, issue),
        link("a", LinkType.RelatesTo, page, session),
        link("b", LinkType.RelatesTo, page, document),
      ],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(groups.map((group) => group.heading)).toEqual([
      "Documents",
      "Sessions",
      "Issues",
      "Branches & pull requests",
      "Deployments",
    ]);
    expect(groups[3]?.rows).toMatchObject([
      {
        href: "https://github.com/o/r/pull/9",
        icon: ArtifactTypeIcons.Branch,
        name: "Host title",
        relationship: null,
        slug: "#9",
        status: "Open",
      },
    ]);
  });

  it("skips a link that does not touch the page", () => {
    const a = endpoint({ id: "doc-a", type: ArtifactType.Document });
    const b = endpoint({ id: "doc-b", type: ArtifactType.Document });
    expect(
      linkedArtifactGroups({
        hrefFor,
        links: [link("a", LinkType.RelatesTo, a, b)],
        pageArtifactId: PAGE_ID,
        pullRequestStatus,
      })
    ).toEqual([]);
  });
});

describe("linkedArtifactGroups extraPullRequests", () => {
  it("leaves out a host pull request a linked branch already draws, per number and repository", () => {
    const branch = endpoint({
      branch: {
        branchName: "feat/x",
        currentPullRequest: pullRequest({
          number: 7,
          repositoryFullName: "Org/Repo",
        }),
      },
      id: "branch-1",
      type: ArtifactType.Branch,
    });

    const [branches] = linkedArtifactGroups({
      extraPullRequests: [
        extraPullRequest({ number: "7", repositoryFullName: "org/repo" }),
        extraPullRequest({ number: "7", repositoryFullName: "org/other" }),
        extraPullRequest({ number: "8", repositoryFullName: "org/repo" }),
        extraPullRequest({ number: "8", repositoryFullName: "org/repo" }),
      ],
      hrefFor,
      links: [link("a", LinkType.RelatesTo, branch, page)],
      pageArtifactId: PAGE_ID,
      pullRequestStatus,
    });

    expect(branches?.rows.map((row) => row.key)).toEqual([
      `branch-1:${LinkType.RelatesTo}:${LinkEnd.Target}`,
      "pull-request:org/other#7",
      "pull-request:org/repo#8",
    ]);
  });

  it("matches a linked pull request with no repository by its URL, and keeps both when neither side can prove identity", () => {
    const branchWith = (id: string, htmlUrl: string | null) =>
      endpoint({
        branch: {
          branchName: `feat/${id}`,
          currentPullRequest: pullRequest({
            htmlUrl,
            number: 7,
            repositoryFullName: null,
          }),
        },
        id,
        type: ArtifactType.Branch,
      });
    const groupKeys = (
      branch: ReturnType<typeof branchWith>,
      extra: LinkedArtifactExtraPullRequest
    ) =>
      linkedArtifactGroups({
        extraPullRequests: [extra],
        hrefFor,
        links: [link("a", LinkType.RelatesTo, branch, page)],
        pageArtifactId: PAGE_ID,
        pullRequestStatus,
      })[0]?.rows.map((row) => row.key);
    const sameUrl = branchWith("b1", "https://github.com/Org/Repo/pull/7/");
    const otherUrl = branchWith("b2", "https://github.com/org/other/pull/7");
    const noUrl = branchWith("b3", null);
    const extra = extraPullRequest({
      href: "https://github.com/org/repo/pull/7",
      number: "7",
      repositoryFullName: "org/repo",
    });

    expect(groupKeys(sameUrl, extra)).toEqual([
      `b1:${LinkType.RelatesTo}:${LinkEnd.Target}`,
    ]);
    expect(groupKeys(otherUrl, extra)).toEqual([
      `b2:${LinkType.RelatesTo}:${LinkEnd.Target}`,
      "pull-request:org/repo#7",
    ]);
    expect(groupKeys(noUrl, extra)).toEqual([
      `b3:${LinkType.RelatesTo}:${LinkEnd.Target}`,
      "pull-request:org/repo#7",
    ]);
  });
});

function extraPullRequest(
  overrides: Partial<LinkedArtifactExtraPullRequest> &
    Pick<LinkedArtifactExtraPullRequest, "number">
): LinkedArtifactExtraPullRequest {
  return {
    href: `https://github.com/o/r/pull/${overrides.number}`,
    repositoryFullName: null,
    status: "Open",
    title: "Host title",
    ...overrides,
  };
}
