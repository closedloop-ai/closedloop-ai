import {
  ArtifactType,
  LinkDirection,
  LinkType,
} from "@repo/api/src/types/artifact";
import { IssueStatus } from "@repo/api/src/types/document";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

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
  warn: vi.fn(),
}));

// ISS-12552: the attribution flag is off for these reads.
vi.mock("@/lib/attribution-evidence-policy-feature", () => ({
  isAttributionEvidenceEnabledForOrganization: vi.fn(async () => false),
}));
vi.mock("@repo/database", () => ({
  withDb: mocks.withDb,
  Prisma: { DbNull: Symbol("DbNull") },
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn() },
}));

vi.mock("@/app/branches/branch-product-eligibility-service", () => ({
  branchProductEligibilityService: { findByIds: mocks.findByIds },
}));

vi.mock("@/app/branches/branch-provider-fallback-service", () => ({
  matchingGitHubPullRequestUrl: mocks.matchingGitHubPullRequestUrl,
}));

import { EmissionRollupCause } from "@/lib/observability/fixed-window-emission-throttle";
import {
  ENDPOINT_ID_CHUNK_SIZE,
  hydrateLinksWithEndpoints,
} from "../link-projections";
import {
  OVERSIZE_LINK_TREE_LINK_COUNT,
  OVERSIZE_LINK_TREE_MAX_PER_WINDOW,
  oversizeLinkTreeThrottle,
} from "../link-tree-oversize-log";
import { ARTIFACT_LINK_PAGE_SIZE, windowForCursor } from "../resolved-page";
import { artifactLinksService } from "../service";

const ORG = "org-1";
const ROOT = "root-artifact";
const HUB = "hub-artifact";

function makeLinkRow(id: string, sourceId: string, targetId: string) {
  return {
    id,
    organizationId: ORG,
    sourceId,
    targetId,
    linkType: LinkType.Produces,
    metadata: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
  };
}

function makeArtifactRow(id: string): Record<string, unknown> {
  return {
    id,
    organizationId: ORG,
    projectId: "project-1",
    type: ArtifactType.Document,
    subtype: null,
    name: `Artifact ${id}`,
    slug: id,
    status: IssueStatus.InProgress,
    priority: null,
    assigneeId: null,
    assignee: null,
    createdById: null,
    dueDate: null,
    externalUrl: null,
    createdAt: new Date("2026-09-01T00:00:00.000Z"),
    updatedAt: new Date("2026-09-01T00:00:00.000Z"),
    branch: null,
  };
}

/**
 * Answer each traversal level from `levels`, then hydrate whatever ids the
 * endpoint read asks for. Returns nothing the production path does not ask for,
 * so a hydration that requested one row per edge end would be visible here as a
 * larger `in` list rather than being quietly satisfied.
 */
function mockGraph(
  levels: ReturnType<typeof makeLinkRow>[][],
  withheldEndpointIds: ReadonlySet<string> = new Set()
) {
  let level = 0;
  mocks.linkFindMany.mockImplementation(() =>
    Promise.resolve(levels[level++] ?? [])
  );
  // `withheldEndpointIds` answers the endpoint read SHORT, which is the one
  // input that makes `hydrateLinksWithEndpoints` drop a link it was handed.
  mocks.artifactFindMany.mockImplementation(
    (args: { where: { id: { in: string[] } } }) =>
      Promise.resolve(
        args.where.id.in
          .filter((id) => !withheldEndpointIds.has(id))
          .map(makeArtifactRow)
      )
  );
}

describe("findResolvedLinkTreePage — allocation bounds (ISS-10041)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // The per-org emission budget is module-level state. Without this the file
    // is order-dependent: whichever case runs first spends the budget and the
    // next one sees a suppression it never asked for.
    oversizeLinkTreeThrottle.clear();
    mocks.findByIds.mockResolvedValue(new Map());
    mocks.matchingGitHubPullRequestUrl.mockReturnValue(null);
    const db = {
      artifactLink: { findMany: mocks.linkFindMany },
      artifactLinkTreePage: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      artifact: { findMany: mocks.artifactFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
  });

  it("materialises a hub endpoint once however many links name it", async () => {
    const spokes = Array.from({ length: 50 }, (_, i) => `spoke-${i}`);
    mockGraph([
      spokes.map((spoke, i) => makeLinkRow(`l-${i}`, ROOT, spoke)),
      spokes.map((spoke, i) => makeLinkRow(`h-${i}`, spoke, HUB)),
    ]);

    const { items: links } =
      await artifactLinksService.findResolvedLinkTreePage(
        ORG,
        ROOT,
        LinkDirection.Both,
        10,
        windowForCursor()
      );

    // Positive control: the walk really did return the whole graph, endpoints
    // hydrated — an empty result would satisfy any row bound.
    expect(links).toHaveLength(100);
    expect(links.filter((l) => l.target.id === HUB)).toHaveLength(50);
    expect(links.at(-1)?.target.name).toBe(`Artifact ${HUB}`);

    // 100 links have 200 edge ends but only 52 distinct artifacts. The bound is
    // the artifact count, which is what makes the read proportional to the
    // graph rather than to the edges over it.
    const requestedIds = mocks.artifactFindMany.mock.calls.flatMap(
      (call) => (call[0] as { where: { id: { in: string[] } } }).where.id.in
    );
    expect(requestedIds).toHaveLength(52);
    expect(new Set(requestedIds).size).toBe(52);
  });

  it("keeps the org predicate on the endpoint read", async () => {
    mockGraph([[makeLinkRow("l-1", ROOT, HUB)]]);

    await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );

    expect(mocks.artifactFindMany.mock.calls[0]?.[0].where).toEqual({
      id: { in: [ROOT, HUB] },
      organizationId: ORG,
    });
  });

  /**
   * Held against `hydrateLinksWithEndpoints` rather than the service, because
   * ISS-10102 put a page between them: a page is at most
   * {@link ARTIFACT_LINK_PAGE_SIZE} links and therefore at most
   * `2 * ARTIFACT_LINK_PAGE_SIZE` endpoint ids, two orders of magnitude under
   * the bind ceiling, so no route call can reach this width any more. The
   * hydrator is still the owner of the guarantee and is still reachable at any
   * width its caller hands it — pinning it at the owner keeps the bind ceiling
   * covered instead of letting a page size that happens to be small read as
   * coverage.
   */
  it("chunks the endpoint read at the Postgres bind ceiling", async () => {
    const endpointCount = ENDPOINT_ID_CHUNK_SIZE + 10;
    const links = Array.from({ length: endpointCount - 1 }, (_, i) =>
      makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
    );
    mockGraph([links]);

    await hydrateLinksWithEndpoints(ORG, links);

    expect(mocks.artifactFindMany).toHaveBeenCalledTimes(2);
    const widths = mocks.artifactFindMany.mock.calls.map(
      (call) =>
        (call[0] as { where: { id: { in: string[] } } }).where.id.in.length
    );
    expect(widths[0]).toBe(ENDPOINT_ID_CHUNK_SIZE);
    expect(widths[1]).toBe(endpointCount - ENDPOINT_ID_CHUNK_SIZE);
  });

  /**
   * The bound ISS-10102 added, asserted on the production path: the traversal
   * walks the whole graph — which is what keeps the oversize record honest —
   * and the HYDRATION, the step that actually holds the memory, never sees more
   * than one page.
   */
  it("hydrates only the page, however large the traversal", async () => {
    const linkCount = ARTIFACT_LINK_PAGE_SIZE + 500;
    mockGraph([
      Array.from({ length: linkCount }, (_, i) =>
        makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
      ),
    ]);

    const page = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );

    expect(page.items).toHaveLength(ARTIFACT_LINK_PAGE_SIZE);
    expect(page.nextCursor).toBe(String(ARTIFACT_LINK_PAGE_SIZE));
    // ROOT plus one leaf per served link — never the 1,501 the walk collected.
    const requestedIds = mocks.artifactFindMany.mock.calls.flatMap(
      (call) => (call[0] as { where: { id: { in: string[] } } }).where.id.in
    );
    expect(requestedIds).toHaveLength(ARTIFACT_LINK_PAGE_SIZE + 1);
  });

  it("omits nextCursor rather than nulling it on the last page", async () => {
    const linkCount = ARTIFACT_LINK_PAGE_SIZE + 500;
    mockGraph([
      Array.from({ length: linkCount }, (_, i) =>
        makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
      ),
    ]);

    const last = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor(ARTIFACT_LINK_PAGE_SIZE)
    );

    expect(last.items).toHaveLength(500);
    // `in`, not a truthiness check: a `null` would satisfy `!last.nextCursor`
    // while still serializing a key the cross-repo contract says is absent.
    expect("nextCursor" in last).toBe(false);
  });

  /**
   * The ordering this PR turns on, and the one mutation the cases above leave
   * alive: `splitPeekedPage` reads the RAW links, so the peek row decides
   * `nextCursor` even when hydration then drops it.
   *
   * `hydrateLinksWithEndpoints` keeps a link only when BOTH endpoint artifacts
   * resolve, so splitting AFTER hydration would let a single dropped row make a
   * 1,001-row read look like a 1,000-row one — `nextCursor` withheld, and both
   * pagers terminate on its absence alone. A 42,060-link lineage would render
   * as 1,000 links and claim to be complete.
   */
  it("emits the cursor from the RAW peek row, not the hydrated count", async () => {
    const linkCount = ARTIFACT_LINK_PAGE_SIZE + 500;
    mockGraph(
      [
        Array.from({ length: linkCount }, (_, i) =>
          makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
        ),
      ],
      // The peek row's endpoint, plus one inside the page: the first decides
      // whether the cursor survives hydration, the second whether the cursor
      // advances by the page SIZE rather than by how many rows survived.
      new Set([`leaf-${ARTIFACT_LINK_PAGE_SIZE}`, "leaf-5"])
    );

    const page = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );

    // Positive control: the withheld endpoint really did drop a link, so the
    // cursor assertion below is not passing on a graph that never dropped one.
    expect(page.items).toHaveLength(ARTIFACT_LINK_PAGE_SIZE - 1);
    expect(page.nextCursor).toBe(String(ARTIFACT_LINK_PAGE_SIZE));
  });

  it("resumes at the cursor without repeating or skipping a link", async () => {
    const linkCount = ARTIFACT_LINK_PAGE_SIZE + 500;
    const level = Array.from({ length: linkCount }, (_, i) =>
      makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
    );

    // Re-armed between the two reads: `mockGraph` answers depth levels from a
    // closure counter, so a second traversal sharing the first one's mock would
    // start at depth 1 and walk an empty graph — a "no rows repeated" pass that
    // proved only that the second page was empty.
    mockGraph([level]);
    const first = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );

    mockGraph([level]);
    const second = await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor(Number(first.nextCursor))
    );

    const ids = [...first.items, ...second.items].map((link) => link.id);
    expect(new Set(ids).size).toBe(linkCount);
    expect(ids).toHaveLength(linkCount);
  });

  it("reports an oversize traversal BEFORE the allocating read", async () => {
    const linkCount = OVERSIZE_LINK_TREE_LINK_COUNT;
    mockGraph([
      Array.from({ length: linkCount }, (_, i) =>
        makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
      ),
    ]);

    await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor(),
      LinkType.Produces
    );

    expect(mocks.warn).toHaveBeenCalledWith("artifact_link_tree_oversize", {
      organizationId: ORG,
      artifactId: ROOT,
      direction: LinkDirection.Both,
      maxDepth: 10,
      linkType: LinkType.Produces,
      links: linkCount,
      distinctEndpoints: linkCount + 1,
      threshold: OVERSIZE_LINK_TREE_LINK_COUNT,
    });
    // The ordering is the whole point: a request killed while hydrating has
    // already written this line. Logging after the read would record nothing,
    // which is the state ISS-10041 exists to end.
    expect(mocks.warn.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.artifactFindMany.mock.invocationCallOrder[0] as number
    );
  });

  it("stays silent for a normally-sized tree", async () => {
    mockGraph([[makeLinkRow("l-1", ROOT, HUB)]]);

    await artifactLinksService.findResolvedLinkTreePage(
      ORG,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );

    expect(mocks.warn).not.toHaveBeenCalled();
  });
});

/**
 * The oversize record sits on an authenticated GET with no rate limiter in
 * front of it, so its emission is bounded per org and the remainder is rolled
 * up rather than dropped (#7126 review, whitlockk). Time is pinned because the
 * bound is a fixed WINDOW — a real clock would make the rollover case a race.
 */
describe("oversize record — per-org emission bound (#7126)", () => {
  const WINDOW_START = new Date("2026-09-11T00:00:00.000Z").getTime();
  const OVERSIZE_LEVEL = Array.from(
    { length: OVERSIZE_LINK_TREE_LINK_COUNT },
    (_, i) => makeLinkRow(`l-${i}`, ROOT, `leaf-${i}`)
  );

  beforeEach(() => {
    vi.clearAllMocks();
    oversizeLinkTreeThrottle.clear();
    mocks.findByIds.mockResolvedValue(new Map());
    mocks.matchingGitHubPullRequestUrl.mockReturnValue(null);
    const db = {
      artifactLink: { findMany: mocks.linkFindMany },
      artifactLinkTreePage: {
        createMany: vi.fn().mockResolvedValue({ count: 1 }),
        findFirst: vi.fn().mockResolvedValue(null),
      },
      artifact: { findMany: mocks.artifactFindMany },
    };
    mocks.withDb.mockImplementation((cb: (client: typeof db) => unknown) =>
      cb(db)
    );
    vi.useFakeTimers();
    vi.setSystemTime(WINDOW_START);
  });

  // Unconditional, never the last line of a case: an assertion that throws
  // mid-case would otherwise leak a frozen clock into every later test.
  afterEach(() => {
    vi.useRealTimers();
    oversizeLinkTreeThrottle.clear();
  });

  /** Re-arms the level mock, then drives one whole oversize tree read. */
  async function readOversizeTree(organizationId: string): Promise<void> {
    mockGraph([OVERSIZE_LEVEL]);
    await artifactLinksService.findResolvedLinkTreePage(
      organizationId,
      ROOT,
      LinkDirection.Both,
      10,
      windowForCursor()
    );
  }

  function detailWarns() {
    return mocks.warn.mock.calls.filter(
      (call) => call[0] === "artifact_link_tree_oversize"
    );
  }

  function rollupWarns() {
    return mocks.warn.mock.calls.filter(
      (call) => call[0] === "artifact_link_tree_oversize_suppressed"
    );
  }

  it("caps detail records per org per window and rolls the rest up", async () => {
    const overBudget = 3;
    for (
      let i = 0;
      i < OVERSIZE_LINK_TREE_MAX_PER_WINDOW + overBudget;
      i += 1
    ) {
      await readOversizeTree(ORG);
    }
    // Touching the key mid-window is what leaves its rollup to `record` rather
    // than to the expiry drain, which is the OTHER cause and its own case
    // below.
    vi.setSystemTime(WINDOW_START + 30_000);
    await readOversizeTree(ORG);

    // Positive control: the budget really was reached, rather than the reads
    // failing to be oversize at all.
    expect(detailWarns()).toHaveLength(OVERSIZE_LINK_TREE_MAX_PER_WINDOW);
    // Nothing is emitted for the suppressed occurrences yet — a suppressed
    // count is materialised by an event, and this window has not closed.
    expect(rollupWarns()).toHaveLength(0);

    vi.setSystemTime(WINDOW_START + 61_000);
    await readOversizeTree(ORG);

    // 10 oversize reads in, 6 detail records plus a rollup of 4 back out: the
    // reader loses the per-request detail, never the occurrence count.
    expect(rollupWarns()).toEqual([
      [
        "artifact_link_tree_oversize_suppressed",
        {
          organizationId: ORG,
          suppressed: overBudget + 1,
          flushedBy: EmissionRollupCause.Window,
          threshold: OVERSIZE_LINK_TREE_LINK_COUNT,
        },
      ],
    ]);
    expect(detailWarns()).toHaveLength(OVERSIZE_LINK_TREE_MAX_PER_WINDOW + 1);
  });

  it("spends the budget per org, so one tenant cannot silence another", async () => {
    for (let i = 0; i < OVERSIZE_LINK_TREE_MAX_PER_WINDOW + 2; i += 1) {
      await readOversizeTree(ORG);
    }
    expect(detailWarns()).toHaveLength(OVERSIZE_LINK_TREE_MAX_PER_WINDOW);

    await readOversizeTree("org-2");

    // A global key would have suppressed this one; the org key does not.
    expect(detailWarns().at(-1)?.[1]).toMatchObject({
      organizationId: "org-2",
    });
  });

  it("drains a closed window on a later read, so a quiet org still rolls up", async () => {
    for (let i = 0; i < OVERSIZE_LINK_TREE_MAX_PER_WINDOW + 1; i += 1) {
      await readOversizeTree(ORG);
    }
    expect(rollupWarns()).toHaveLength(0);

    // The suppressed org goes quiet. Another org's read is the terminal path
    // that reclaims it — without the drain the count would sit in memory until
    // the SAME org happened to be oversize again.
    vi.setSystemTime(WINDOW_START + 61_000);
    await readOversizeTree("org-3");

    expect(rollupWarns()).toEqual([
      [
        "artifact_link_tree_oversize_suppressed",
        {
          organizationId: ORG,
          suppressed: 1,
          flushedBy: EmissionRollupCause.Expiry,
          threshold: OVERSIZE_LINK_TREE_LINK_COUNT,
        },
      ],
    ]);
  });
});
