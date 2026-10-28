import {
  GitHubCredentialKind,
  GitHubPRState,
} from "@repo/api/src/types/github";
import {
  GitHubFetchTrigger,
  type GitHubReadModelPullRequest,
  GitHubReadModelSource,
} from "@repo/api/src/types/github-read-model";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  // The source resolves the repo with installation.status = ACTIVE.
  GitHubInstallationStatus: { ACTIVE: "ACTIVE" },
  // Reached at import time through the branch-canonical select chain.
  ArtifactType: { BRANCH: "BRANCH", DOCUMENT: "DOCUMENT" },
  LinkType: { Produces: "PRODUCES", RelatesTo: "RELATES_TO" },
}));

const getTrackedMock = vi.hoisted(() => vi.fn());
vi.mock("./tracked-pull-requests", () => ({
  getTrackedPullRequestState: getTrackedMock,
}));

import { mapPullRequestNode } from "@repo/api/src/github-read-model";
import { withDb } from "@repo/database";
import type { GitHubSinglePullRequestResult } from "@repo/github";
import { mapRepositoryPullRequest } from "@repo/github/repository-pull-request-list";
import {
  BRANCH_CURRENT_BASE_DECOY,
  ORG,
  PARITY_PR,
  parityRow,
  REPO_SELECTOR,
} from "@/__tests__/support/integrations/github/projection-read.test-fixtures";
import { reconciledPullRequestDetailData } from "@/app/cron/reconcile-pull-requests/reconcile-projection-write";
import { githubAppRestFetchProvenance } from "@/lib/github-fetch-provenance";
import { readRepositoryPullRequestsFromProjection } from "./projection-read";
import { tombstonedPullRequestSettleData } from "./tombstoned-pr-settle-data";

const mockWithDb = withDb as unknown as ReturnType<typeof vi.fn>;

const prFindMany = vi.fn();
const observedRepoFindFirst = vi.fn();

beforeEach(() => {
  vi.clearAllMocks();
  const db = {
    pullRequestDetail: { findMany: prFindMany },
    gitHubObservedRepository: { findFirst: observedRepoFindFirst },
  };
  mockWithDb.mockImplementation((fn: (client: unknown) => unknown) => fn(db));
  // ISS-8049: the observed lane resolves only when a test seeds a row.
  observedRepoFindFirst.mockResolvedValue(null);
});

// Both producers fill the same GitHubPullRequestSummary contract for the same
// route, so a field they disagree on is a flag-flip behavior change. Desktop
// keys its cloud PR overlays by headBranch, so a disagreement there drops a
// branch from the Desktop Branch read rather than just mislabelling a row.
/**
 * The GitHub-backed producers that write a PR's base ref, each represented by
 * the payload its own lane hands Prisma. Adding a lane here is how a new
 * producer proves it stamps the PR columns rather than only the Branch's.
 */
const PRODUCER_DETAIL_ARMS = [
  {
    name: "tombstoned-repo-settle",
    write: (authorLogin: string | null) =>
      tombstonedPullRequestSettleData(
        parityFreshPr({ authorLogin }),
        new Date("2026-02-11T09:00:00Z"),
        PARITY_PROVENANCE()
      ),
  },
  // ISS-8158. The PRD-683 targeted (fetch-by-number) sync consumes the READ
  // MODEL rather than the REST lifecycle shape the settle lane above takes, which
  // is why an arm receives one shared author fact and spells the fixture in its
  // own lane's currency instead of being handed a payload — otherwise the
  // comparison stops being producer-to-producer.
  {
    name: "targeted-sync",
    write: (authorLogin: string | null) =>
      reconciledPullRequestDetailData(
        parityReadModelPr(authorLogin),
        PARITY_RECONCILE_CONTEXT()
      ),
  },
] as const;

describe("pull-request producer parity", () => {
  it("agrees with the live GraphQL mapper on headBranch for one fixture", async () => {
    prFindMany.mockResolvedValue([parityRow()]);

    const [projected] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;
    const live = parityReadModelPr(null);

    expect(live.headBranch).toBe(PARITY_PR.headRefName);
    expect(projected.headBranch).toBe(live.headBranch);
    expect(projected.githubId).toBe(live.githubId);
    expect(projected.number).toBe(live.number);
  });

  // ISS-8155 AC-3. The webhook fills base_ref_name and author_login from the
  // same provider facts the live mapper reads off the node, so the two producers
  // must land on the same words for one PR. Drift here is a flag-flip behavior
  // change: the same PR would report a different base or a different author
  // depending only on which lane served the request.
  it("agrees with the live GraphQL mapper on baseBranch and author", async () => {
    prFindMany.mockResolvedValue([
      parityRow({ authorLogin: PARITY_PR.authorLogin }),
    ]);

    const [projected] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;
    const live = liveParitySummary(PARITY_PR.authorLogin);

    expect(live.baseBranch).toBe(PARITY_PR.baseBranch);
    expect(live.author).toBe(PARITY_PR.authorLogin);
    expect(projected.baseBranch).toBe(live.baseBranch);
    expect(projected.author).toBe(live.author);
  });

  // The absent case has to agree too, or the two lanes disagree about what
  // "we did not measure this" looks like and only one surface can render it.
  it("agrees with the live GraphQL mapper on an unattributed author", async () => {
    prFindMany.mockResolvedValue([parityRow({ authorLogin: null })]);

    const [projected] = (
      await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
        limit: 30,
        targetNumbers: [],
      })
    ).pullRequests;
    const live = liveParitySummary(null);

    expect(live.author).toBe("");
    expect(projected.author).toBe(live.author);
  });

  // ISS-8162 AC-2/AC-3, extended by ISS-8176 and ISS-8158. The webhook is not
  // the only producer that learns a PR's base from GitHub: the tombstoned-repo
  // settle and PRD-683 targeted-sync lanes read the same provider facts. The
  // settle lane also writes the owning BRANCH's base in the same transaction
  // (ISS-11588 deleted the refresh and repair lanes, which did too); targeted
  // sync does NOT — it reaches the projection through
  // `writeReconciledPullRequest`, whose contract is detail-only and must not
  // touch branch-owned state. What every arm below pins is therefore the
  // PR-DETAIL payload, which is the contract this read actually serves.
  // Each arm drives that lane's detail PAYLOAD BUILDER into the row this read
  // serves, so the counterfactual
  // is the one that shipped — a payload that carries the branch-level base and
  // skips the PR column leaves base_ref_name unstamped, the read falls to the
  // absent form, and these go red. A payload that merely wrote SOMETHING cannot
  // satisfy them either: the fixture's branch carries BRANCH_CURRENT_BASE_DECOY,
  // so borrowing the branch's base fails too.
  //
  // Scope, deliberately: this pins the payload each lane BUILDS, not that the
  // lane still hands that payload to Prisma. The call sites are pinned where
  // they live: `./sync-service.test.ts` asserts the base and author on the
  // settle lane's own real `pullRequestDetail.updateMany`.
  //
  // `checksStatus` — ISS-8158 AC-3's third field — is deliberately NOT asserted
  // per arm. It is a BranchDetail column no detail payload can carry, so a
  // per-arm assertion would read the same fixture constant once per arm and could
  // not fail for any lane. Its two branches are pinned once, producer-independent
  // because that is the truth, in `./projection-read.test.ts`: the current PR
  // serves the branch head's rollup, and "reports no checks rollup for a PR the
  // branch has superseded" serves null.
  //
  // The targeted lane's call site takes two hops, pinned one file each:
  // `reconcile-pull-requests/__tests__/targeted-reconciler.test.ts` asserts the
  // fetched provider PR reaches `writeReconciledPullRequest`, and
  // `.../__tests__/reconcile-projection-write.test.ts` asserts that write hands
  // the composed payload to `pullRequestDetail.updateMany`. That second file
  // MOCKS the shared builder, so between them they pin the route and the
  // builder's INPUT but never the real payload — which is why this lane's
  // omission contract is pinned below rather than in its own suite, unlike its
  // settle sibling.
  for (const arm of PRODUCER_DETAIL_ARMS) {
    it(`serves the base and author in ${arm.name}'s detail payload`, async () => {
      const written = arm.write(PARITY_PR.authorLogin);
      prFindMany.mockResolvedValue([
        parityRow({
          authorLogin: writtenColumn(written.authorLogin),
          baseRefName: writtenColumn(written.baseRefName),
        }),
      ]);

      const [projected] = (
        await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
          limit: 30,
          targetNumbers: [],
        })
      ).pullRequests;
      const live = liveParitySummary(PARITY_PR.authorLogin);

      expect(projected.baseBranch).toBe(live.baseBranch);
      expect(projected.author).toBe(live.author);
      expect(projected.baseBranch).not.toBe(BRANCH_CURRENT_BASE_DECOY);
      expect(projected.baseBranch).not.toBe("");
    });

    // The unattributed PR is the other half of the same agreement: GitHub
    // reports no `user` for a deleted account, and every lane must still land on
    // the base it measured plus the one absent form the surface can name.
    //
    // Scope, deliberately: this pins that the lanes AGREE on the unattributed
    // read, NOT that any of them omits rather than nulls. Those two spellings
    // are indistinguishable here on purpose — the read coalesces both to the
    // absent form — so the omission contract is pinned where it is observable,
    // on each lane's own write (this lane's is in `./sync-service.test.ts`).
    it(`serves the base and an absent author in ${arm.name}'s detail payload`, async () => {
      const written = arm.write(null);
      prFindMany.mockResolvedValue([
        parityRow({
          authorLogin: writtenColumn(written.authorLogin),
          baseRefName: writtenColumn(written.baseRefName),
        }),
      ]);

      const [projected] = (
        await readRepositoryPullRequestsFromProjection(REPO_SELECTOR, ORG, {
          limit: 30,
          targetNumbers: [],
        })
      ).pullRequests;
      const live = liveParitySummary(null);

      expect(live.author).toBe("");
      expect(projected.author).toBe(live.author);
      // An absent author must not take the measured base down with it.
      expect(projected.baseBranch).toBe(PARITY_PR.baseBranch);
      expect(projected.baseBranch).not.toBe(BRANCH_CURRENT_BASE_DECOY);
      expect(projected.baseBranch).not.toBe("");
    });
  }

  // ISS-8158. Routing a producer through the shared builder makes it write
  // `authorLogin` for the first time, and a `null` there CLEARS a login the
  // webhook measured — the ISS-8162 collapse, one lane over. The targeted lane's
  // own suite mocks the shared builder, so this is the only place the real
  // payload is observable. `not.toHaveProperty` rather than
  // `not.objectContaining({ authorLogin: expect.anything() })`, which passes
  // under its own mutation because `expect.anything()` does not match null.
  it("omits authorLogin rather than nulling it when targeted-sync measures no author", () => {
    const written = reconciledPullRequestDetailData(
      parityReadModelPr(null),
      PARITY_RECONCILE_CONTEXT()
    );

    expect(written).not.toHaveProperty("authorLogin");
    // The absent author must not take the measured base down with it.
    expect(written.baseRefName).toBe(PARITY_PR.baseBranch);
  });
});

/**
 * The PARITY_PR facts as the LIVE lane serves them: the provider node through
 * the GraphQL read-model mapper and then through the wire mapper the live route
 * actually returns, so the comparison is producer-to-producer on one contract.
 */
function liveParitySummary(authorLogin: string | null) {
  return mapRepositoryPullRequest(
    parityReadModelPr(authorLogin),
    "acme/widgets"
  );
}

/**
 * The PARITY_PR facts as the READ MODEL carries them — the currency the
 * reconcile lanes consume, and the same value the live arm is compared against.
 *
 * The targeted arm takes its input from here rather than from a hand-written
 * literal so the fixture cannot become a second spelling that drifts out from
 * under the comparison: one provider node, one mapper, both arms.
 */
function parityReadModelPr(
  authorLogin: string | null
): GitHubReadModelPullRequest {
  const node = mapPullRequestNode(
    {
      id: PARITY_PR.nodeId,
      databaseId: PARITY_PR.databaseId,
      number: PARITY_PR.number,
      title: PARITY_PR.title,
      url: PARITY_PR.htmlUrl,
      baseRefName: PARITY_PR.baseBranch,
      headRefName: PARITY_PR.headRefName,
      headRefOid: PARITY_PR.headRefOid,
      author: authorLogin === null ? null : { login: authorLogin },
    },
    GitHubReadModelSource.Provider
  );
  if (!node) {
    throw new Error("the live mapper rejected the parity fixture");
  }
  return node;
}

/**
 * One targeted-sync sweep context, so that arm differs from its siblings only in
 * lane: the very context shape production hands the builder.
 */
function PARITY_RECONCILE_CONTEXT() {
  return {
    organizationId: ORG,
    repositoryId: "repo-row-1",
    repositoryFullName: "acme/widgets",
    credentialKind: GitHubCredentialKind.Installation,
    credentialOwnerId: null,
    now: new Date("2026-02-11T09:00:00Z"),
  };
}

/**
 * The acquisition stamp the REST-payload (settle) arm writes. The targeted-sync
 * arm builds its own from `credentialKind`, because that is what its lane
 * actually does.
 */
function PARITY_PROVENANCE() {
  return githubAppRestFetchProvenance({
    observedAt: new Date("2026-02-11T09:00:00Z"),
    trigger: GitHubFetchTrigger.SurfaceOpen,
  });
}

/**
 * The PARITY_PR facts as GitHub's REST PR payload delivers them to the settle
 * lane, typed as the `GitHubSinglePullRequestResult` that lane takes: the same
 * provider facts the live GraphQL node carries, so a disagreement between the
 * arms is the mapping, never the input.
 */
function parityFreshPr(
  overrides: Partial<GitHubSinglePullRequestResult> = {}
): GitHubSinglePullRequestResult {
  return {
    githubId: String(PARITY_PR.databaseId),
    number: PARITY_PR.number,
    title: PARITY_PR.title,
    htmlUrl: PARITY_PR.htmlUrl,
    headBranch: PARITY_PR.headRefName,
    baseBranch: PARITY_PR.baseBranch,
    state: GitHubPRState.Merged,
    createdAt: "2026-02-10T09:00:00.000Z",
    mergedAt: "2026-02-11T09:00:00.000Z",
    closedAt: "2026-02-11T09:00:00.000Z",
    authorLogin: PARITY_PR.authorLogin,
    isDraft: false,
    headSha: PARITY_PR.headRefOid,
    baseSha: "base-oid",
    mergeCommitSha: "merge-sha",
    ...overrides,
  };
}

/**
 * What one projected column reads back as for a row THIS payload is the only
 * writer of — the narrow question the arms above ask, not a general model of
 * Prisma's update semantics.
 *
 * That narrowness is the whole point of the `undefined` branch. On a row some
 * richer producer already stamped, an omitted key preserves the stored value and
 * `null` would be the wrong answer; on a row only this lane ever wrote — the
 * ISS-8162 row — an omitted key means the column was never filled, and the read
 * serves the absent form. Only the second row is under test here, and the branch
 * is reached exactly when a lane regresses to skipping the column.
 *
 * Prisma also permits an operation object (`{ set: … }`). No builder on these
 * paths emits one, and quietly reading it as an absence would turn a payload
 * this helper cannot interpret into a passing test.
 */
function writtenColumn(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }
  if (value === null || value === undefined) {
    return null;
  }
  throw new Error(
    `producer payload wrote a column shape this assertion cannot read: ${JSON.stringify(value)}`
  );
}
