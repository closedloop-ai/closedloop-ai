/**
 * ISS-7732: the resolved-link endpoint projection must hydrate `assignee`.
 *
 * Without the join the endpoint carries `assigneeId` with no user, and every
 * consumer (PRD "Associated Artifacts", the plan's parent-context row) renders
 * that absence as a confident "unassigned" — a missing input presented as a
 * definite value.
 *
 * Both halves matter and fail independently: the include assertion catches
 * deleting the join (a mocked db would happily keep returning a user without
 * it), and the projection assertions catch dropping the field on the way out.
 */
import {
  ArtifactSubtype,
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import type { BasicUser } from "@repo/api/src/types/user";
import { beforeEach, describe, expect, it, vi } from "vitest";

// PRODUCES admission reads the organization graph and placement state, which
// this suite's database fake does not model; its own coverage is the
// produces-cycle-admission integration suite.
vi.mock("@/app/artifact-links/produces-link-admission", () => ({
  refuseProducesLinkCycle: vi.fn(async () => null),
  refuseProducesLinkDepth: vi.fn(async () => null),
}));

const mocks = vi.hoisted(() => ({
  linkFindMany: vi.fn(),
  artifactFindMany: vi.fn(),
  withDb: Object.assign(vi.fn(), { tx: vi.fn() }),
  findByIds: vi.fn(),
  matchingGitHubPullRequestUrl: vi.fn(),
}));

vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: Symbol("DbNull") },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: mocks.findByIds },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  matchingGitHubPullRequestUrl: mocks.matchingGitHubPullRequestUrl,
}));

import { basicUserSelect } from "@/lib/db-utils";
import { windowForCursor } from "../resolved-page";
import { artifactLinksService } from "../service";

const ORG = "org-1";
const PRD_ID = "prd-1";

const KERENSA: BasicUser = {
  id: "user-kerensa",
  email: "kerensa.whitlock@closedloop.ai",
  firstName: "Kerensa",
  lastName: "Whitlock",
  avatarUrl: null,
};

function makeArtifactRow(
  id: string,
  assignee: BasicUser | null
): Record<string, unknown> {
  return {
    id,
    organizationId: ORG,
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: ArtifactSubtype.Feature,
    name: `Artifact ${id}`,
    slug: id.toUpperCase(),
    status: IssueStatus.InProgress,
    priority: null,
    assigneeId: assignee?.id ?? null,
    assignee,
    createdById: "user-2",
    dueDate: null,
    externalUrl: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    updatedAt: new Date("2026-08-01T00:00:00.000Z"),
    branch: null,
  };
}

function makeLinkRow(targetAssignee: BasicUser | null) {
  return {
    id: "link-1",
    organizationId: ORG,
    sourceId: PRD_ID,
    targetId: "iss-7495",
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
    source: makeArtifactRow(PRD_ID, null),
    target: makeArtifactRow("iss-7495", targetAssignee),
  };
}

/** What the traversal's own `select` returns: link columns, no endpoints. */
function makeBareLinkRow() {
  return {
    id: "link-1",
    organizationId: ORG,
    sourceId: PRD_ID,
    targetId: "iss-7495",
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-08-01T00:00:00.000Z"),
  };
}

describe("findResolvedLinksPage — endpoint assignee hydration (ISS-7732)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIds.mockResolvedValue(new Map());
    mocks.matchingGitHubPullRequestUrl.mockReturnValue(null);
    const db = { artifactLink: { findMany: mocks.linkFindMany } };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
  });

  it("joins the assignee on both link endpoints", async () => {
    mocks.linkFindMany.mockResolvedValue([makeLinkRow(KERENSA)]);

    await artifactLinksService.findResolvedLinksPage(
      ORG,
      PRD_ID,
      LinkDirection.Both,
      windowForCursor()
    );

    expect(mocks.linkFindMany).toHaveBeenCalledTimes(1);
    const [args] = mocks.linkFindMany.mock.calls[0] as [
      { include: { source: { include: Record<string, unknown> } } },
    ];
    expect(args.include.source.include.assignee).toEqual(basicUserSelect);
    const withTarget = args.include as unknown as {
      target: { include: Record<string, unknown> };
    };
    expect(withTarget.target.include.assignee).toEqual(basicUserSelect);
  });

  it("carries the hydrated assignee onto the resolved endpoint", async () => {
    mocks.linkFindMany.mockResolvedValue([makeLinkRow(KERENSA)]);

    const {
      items: [link],
    } = await artifactLinksService.findResolvedLinksPage(
      ORG,
      PRD_ID,
      LinkDirection.Both,
      windowForCursor()
    );

    expect(link.target.assigneeId).toBe(KERENSA.id);
    expect(link.target.assignee).toEqual(KERENSA);
  });

  it("leaves the endpoint assignee null when the artifact is unassigned", async () => {
    mocks.linkFindMany.mockResolvedValue([makeLinkRow(null)]);

    const {
      items: [link],
    } = await artifactLinksService.findResolvedLinksPage(
      ORG,
      PRD_ID,
      LinkDirection.Both,
      windowForCursor()
    );

    expect(link.target.assigneeId).toBeNull();
    expect(link.target.assignee).toBeNull();
  });
});

/**
 * The reported screen (PRD "Associated Artifacts") queries with `mode=tree`,
 * which routes to `findResolvedLinkTreePage` — a DIFFERENT method with its own
 * hydration read. Covering only the direct path would leave the actual bug
 * surface unpinned if the two includes ever diverge.
 *
 * ISS-10041 moved that hydration off `artifactLink.findMany({ include: {
 * source, target } })` and onto a deduplicated `artifact.findMany({ include:
 * endpointInclude })`, so the join now lives one level up. The ISS-7732
 * contract is unchanged and both halves below still fail independently.
 */
describe("findResolvedLinkTreePage — endpoint assignee hydration (ISS-7732)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.findByIds.mockResolvedValue(new Map());
    mocks.matchingGitHubPullRequestUrl.mockReturnValue(null);
    const db = {
      artifactLink: { findMany: mocks.linkFindMany },
      artifact: { findMany: mocks.artifactFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
    // One traversal read per depth level. Only the first frontier — the root —
    // has an edge; the level below it is a leaf.
    mocks.linkFindMany.mockImplementation(
      (args: { where?: { sourceId?: { in?: string[] } } }) =>
        Promise.resolve(
          args.where?.sourceId?.in?.includes(PRD_ID) ? [makeBareLinkRow()] : []
        )
    );
    mocks.artifactFindMany.mockResolvedValue([
      makeArtifactRow(PRD_ID, null),
      makeArtifactRow("iss-7495", KERENSA),
    ]);
  });

  it("joins the assignee on the tree-mode hydration read", async () => {
    await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      PRD_ID,
      LinkDirection.Target,
      2,
      windowForCursor(),
      LinkType.Produces
    );

    expect(mocks.artifactFindMany).toHaveBeenCalledTimes(1);
    const include = mocks.artifactFindMany.mock.calls[0]?.[0].include as Record<
      string,
      unknown
    >;
    expect(include.assignee).toEqual(basicUserSelect);
  });

  it("carries the hydrated assignee onto the tree-mode endpoint", async () => {
    const { items: links } =
      await artifactLinksService.findResolvedLinkTreePage(
        ORG,
        PRD_ID,
        LinkDirection.Target,
        2,
        windowForCursor(),
        LinkType.Produces
      );

    expect(links).toHaveLength(1);
    expect(links[0].target.assignee).toEqual(KERENSA);
  });

  it("reads each distinct endpoint artifact once (ISS-10041)", async () => {
    await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      PRD_ID,
      LinkDirection.Target,
      2,
      windowForCursor(),
      LinkType.Produces
    );

    // The link names two endpoints, so the hydration asks for two ids in one
    // statement — never one row per edge end.
    expect(mocks.artifactFindMany).toHaveBeenCalledTimes(1);
    expect(mocks.artifactFindMany.mock.calls[0]?.[0].where).toEqual({
      id: { in: [PRD_ID, "iss-7495"] },
      organizationId: ORG,
    });
  });
});
