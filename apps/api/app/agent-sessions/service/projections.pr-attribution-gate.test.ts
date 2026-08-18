// ISS-4768: the Authored gate applied to EVERY path a PR can enter a session's
// rendered set — not just link-derived PRs.
//
// The desktop-reported legacy `pullRequests` JSON blob used to be seeded
// ungated, which made it the one way a PR the session never authored could
// surface. The blob is produced by a desktop sync query that admits a PR linked
// by `relation IN ('created','workspace')` OR `method = 'harness_pr_link'`, so a
// harness-reported pr-link record — or a branch↔PR association the session only
// touched via its CWD checkout — landed in the blob and rendered verbatim, while
// a link-derived PR of the exact same (Referenced) purpose was correctly
// dropped. These tests pin the single reconciled rule and its deliberate
// backward-compatibility escape for pre-link legacy rows.

import { PullRequestState } from "@repo/api/src/types/document";
import {
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { SessionPrLifecycleStatus } from "@repo/lib/session-trace/derivation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildSessionListRecord,
  installDb,
} from "@/__tests__/support/agent-sessions/service.test-harness";
import { agentSessionsService } from "../service";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const REPO = "closedloop-ai/symphony-alpha";
const OTHER_REPO = "closedloop-ai/other-repo";
const MERGED_AT = new Date("2026-07-26T09:00:00.000Z");
const VERIFIED_AT = new Date("2026-07-26T09:01:00.000Z");

/**
 * A session→PR source link at `(repositoryFullName, prNumber)` with the given
 * purpose. `withVerifiedDetail` attaches a freshness-verified, lifecycle-observed
 * branch detail — the enrichment source the purpose-agnostic pass reads.
 */
function prSourceLink({
  prNumber,
  relationType,
  repositoryFullName = REPO,
  withVerifiedDetail = false,
  title = "Verified title",
}: {
  prNumber: number;
  relationType: SessionPrRelationType;
  repositoryFullName?: string;
  withVerifiedDetail?: boolean;
  title?: string;
}) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionPr,
      relationTypes: [relationType],
      repositoryFullName,
      prNumber,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: withVerifiedDetail
      ? {
          branch: {
            repository: { fullName: repositoryFullName },
            currentPullRequestDetail: {
              number: prNumber,
              title,
              prState: PullRequestState.Merged,
              closedAt: null,
              mergedAt: MERGED_AT,
              lastVerifiedAt: VERIFIED_AT,
              isCurrent: true,
              repository: { fullName: repositoryFullName },
            },
          },
        }
      : {},
  };
}

/**
 * A branch-only source link — the shape a session gets when it merely CHECKED
 * OUT a branch (`start_branch` / `git_checkout` / the CWD-derived `tu.gitBranch`
 * fallback). It declares NO `prNumber`, yet the branch it points at carries a
 * `currentPullRequestDetail`: the FEA-2531 phantom-branch inheritance path.
 */
function cwdBranchSourceLink(prNumber: number) {
  return {
    metadata: {
      linkKind: SessionArtifactLinkKind.SessionBranch,
      repositoryFullName: REPO,
      source: "DETERMINISTIC",
      confidence: 1.0,
      extractorVersion: 1,
    },
    target: {
      name: "someone-elses-branch/head",
      branch: {
        repository: { fullName: REPO },
        currentPullRequestDetail: {
          number: prNumber,
          title: "Branch's own PR",
          prState: PullRequestState.Merged,
          closedAt: null,
          mergedAt: MERGED_AT,
          lastVerifiedAt: VERIFIED_AT,
          isCurrent: true,
          repository: { fullName: REPO },
        },
      },
    },
  };
}

function installSession({
  pullRequests,
  sourceLinks,
  repositoryFullName,
  branch = "attribution-session/head",
}: {
  pullRequests: unknown[];
  sourceLinks: unknown[];
  repositoryFullName?: string | null;
  branch?: string;
}) {
  installDb({
    sessionDetail: {
      findMany: vi.fn().mockResolvedValue([
        buildSessionListRecord({
          branch,
          ...(repositoryFullName === undefined ? {} : { repositoryFullName }),
          pullRequests,
          artifact: {
            name: "Attribution session",
            status: "completed",
            slug: "SES-ATTR",
            project: null,
            sourceLinks,
          },
        }),
      ]),
      count: vi.fn().mockResolvedValue(1),
    },
  });
}

async function findFirstSession() {
  const result = await agentSessionsService.findSessions({
    organizationId: "org-1",
    filters: {},
  });
  return result.items[0];
}

describe("ISS-4768 session→PR attribution gate", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // The ISS-4768 report shape: session 019fa508 (a `/model`-switch session whose
  // transcript names no PR) rendering PR #3837. In the operator's local desktop
  // store #3837's ONLY session links are `referenced|harness_pr_link` and
  // `referenced|pr_url_in_tool_use` — no `created` link exists — yet the desktop
  // sync query's `OR sal.method = 'harness_pr_link'` arm put it in the blob.
  it("does not surface a legacy-blob PR whose only link evidence is Referenced", async () => {
    installSession({
      pullRequests: [
        {
          num: 3837,
          title: "PR #3837",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 3837,
          relationType: SessionPrRelationType.Referenced,
          withVerifiedDetail: true,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([]);
    expect(session?.prsMerged).toBe(0);
  });

  // A REVIEWED link is a deliberate relationship but still authored nothing
  // (FEA-3585). The blob must not smuggle a reviewed PR in as this session's own.
  it("does not surface a legacy-blob PR whose only link evidence is Reviewed", async () => {
    installSession({
      pullRequests: [
        {
          num: 991,
          title: "PR #991",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 991,
          relationType: SessionPrRelationType.Reviewed,
          withVerifiedDetail: true,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([]);
  });

  // ISS-4768 path 2 (the FEA-2531 phantom-branch class): the session is linked to
  // a branch it only touched via its CWD checkout, and that branch carries its own
  // PR. `session.gitBranch` reports the CWD checkout, not attribution, so the
  // branch's PR is NOT this session's. The blob carries it; the gate drops it.
  it("does not surface a blob PR the session only inherited from a CWD-derived branch link", async () => {
    installSession({
      pullRequests: [
        {
          num: 4242,
          title: "PR #4242",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        // The session DID author something else, so it has real PR link
        // evidence — the compat escape below must not rescue #4242.
        prSourceLink({
          prNumber: 7,
          relationType: SessionPrRelationType.Created,
        }),
        cwdBranchSourceLink(4242),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs?.map((pr) => pr.num)).toEqual([7]);
  });

  // The other half of the rule: a genuinely authored PR still surfaces, and the
  // verified detail on ANY link (referenced included) still enriches it. This is
  // the FEA-4251 enrichment path, now reachable only for an admitted PR.
  it("surfaces a legacy-blob PR the session authored, enriched by a referenced link's verified detail", async () => {
    installSession({
      pullRequests: [
        {
          num: 4210,
          title: "PR #4210",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 4210,
          relationType: SessionPrRelationType.Created,
        }),
        prSourceLink({
          prNumber: 4210,
          relationType: SessionPrRelationType.Referenced,
          withVerifiedDetail: true,
          title: "Real merged title",
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([
      {
        num: 4210,
        title: "Real merged title",
        status: SessionPrLifecycleStatus.Merged,
      },
    ]);
    expect(session?.prsMerged).toBe(1);
  });

  // FEA-4251 (moved here from `projections.pull-requests.test.ts` by ISS-4768):
  // the fallback stays honest. A legacy blob PR the session DID author, but whose
  // only detail is UNVERIFIED on every link, is genuinely unresolvable and keeps
  // its "unknown" placeholder rather than being laundered into a claimed state.
  it("keeps an authored legacy-blob PR unknown when the referenced link's detail is unverified", async () => {
    installSession({
      pullRequests: [
        {
          num: 4211,
          title: "PR #4211",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 4211,
          relationType: SessionPrRelationType.Created,
        }),
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionPr,
            relationTypes: [SessionPrRelationType.Referenced],
            repositoryFullName: REPO,
            prNumber: 4211,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: {
            branch: {
              repository: { fullName: REPO },
              currentPullRequestDetail: {
                number: 4211,
                title: "Unverified title",
                prState: PullRequestState.Merged,
                closedAt: null,
                mergedAt: MERGED_AT,
                // Not freshness-verified → must not resolve state.
                lastVerifiedAt: null,
                isCurrent: true,
                repository: { fullName: REPO },
              },
            },
          },
        },
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([
      {
        num: 4211,
        title: "PR #4211",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
    expect(session?.prsMerged).toBe(0);
  });

  // COMPATIBILITY (do not narrow without approval): a stored row that predates
  // session→PR link extraction has a blob and NO link-declared PR identity. There
  // is nothing to adjudicate against, so the blob is kept exactly as before —
  // graceful degradation, never silent deletion of a legacy session's only PRs.
  it("keeps a legacy-blob PR when the session declares no PR link identities at all", async () => {
    installSession({
      pullRequests: [
        {
          num: 1234,
          title: "PR #1234",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([
      {
        num: 1234,
        title: "PR #1234",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
  });

  // A branch-only link declares no PR identity, so it does not by itself switch
  // the blob into adjudicated mode — the pre-link legacy row above keeps working
  // for a session that also synced a branch link.
  it("keeps a legacy-blob PR when the session's only link is a branch link declaring no PR", async () => {
    installSession({
      pullRequests: [
        {
          num: 555,
          title: "PR #555",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        {
          metadata: {
            linkKind: SessionArtifactLinkKind.SessionBranch,
            repositoryFullName: REPO,
            source: "DETERMINISTIC",
            confidence: 1.0,
            extractorVersion: 1,
          },
          target: { name: "attribution-session/head", branch: null },
        },
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs?.map((pr) => pr.num)).toEqual([555]);
  });

  // PR identity is repo-full-name + number. An authored PR #42 in one repository
  // must not admit a blob entry for a DIFFERENT repository's PR #42. The authored
  // link's own PR still surfaces (it is real) — but at its own identity and
  // WITHOUT the other repository's blob title, which is how we can tell the blob
  // entry was rejected rather than folded in. `sessionPrWithLifecycle` defaults a
  // title-less PR to `PR #<num>`, so the default title here IS the proof.
  it("does not let an authored PR admit a same-number blob PR from another repository", async () => {
    installSession({
      repositoryFullName: OTHER_REPO,
      pullRequests: [
        {
          num: 42,
          title: "Other repo blob title",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 42,
          relationType: SessionPrRelationType.Created,
          repositoryFullName: REPO,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([
      {
        num: 42,
        title: "PR #42",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
  });

  // The same identity rule with no authored link at all: a blob entry for one
  // repository is not admitted by a REFERENCED link in another. Nothing survives.
  it("does not surface a same-number blob PR from another repository with no authored link", async () => {
    installSession({
      repositoryFullName: OTHER_REPO,
      pullRequests: [
        {
          num: 43,
          title: "Other repo blob title",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 43,
          relationType: SessionPrRelationType.Referenced,
          repositoryFullName: REPO,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([]);
  });

  // The number-only fallback is the documented legacy path for a record with no
  // `repositoryFullName` — the same repo-less case `legacy#<n>` already serves.
  // A blob `num` that arrived as a string normalizes identically to a link's
  // numeric `prNumber`.
  it("admits a repo-less legacy blob entry from its authored link by number", async () => {
    installSession({
      repositoryFullName: null,
      pullRequests: [
        {
          num: "77",
          title: "PR #77",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 77,
          relationType: SessionPrRelationType.Created,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs?.map((pr) => pr.num)).toEqual([77]);
  });

  // Incomplete link evidence must not delete a real PR (bot + codex review). The
  // gate is PER PR, not a per-session switch: the desktop producer caps the blob
  // and `prRefs` at 100 through independent orderings, so a PR-heavy session can
  // legitimately carry an authored blob PR whose link was capped out while other
  // links survive. #900 is spoken about by NO link, so it is unadjudicated and
  // kept; #901 is spoken about and classified Referenced, so it is the phantom
  // and is dropped. One session proves both halves of the rule.
  it("keeps a blob PR no link adjudicates even when other PR links exist", async () => {
    installSession({
      pullRequests: [
        {
          num: 900,
          title: "PR #900",
          status: SessionPrLifecycleStatus.Unknown,
        },
        {
          num: 901,
          title: "PR #901",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 5,
          relationType: SessionPrRelationType.Created,
        }),
        prSourceLink({
          prNumber: 901,
          relationType: SessionPrRelationType.Referenced,
        }),
      ],
    });

    const session = await findFirstSession();

    // `SessionPR["num"]` is `number | string`, so the ordering comparator has to
    // coerce — but the ASSERTED values stay the raw `pr.num`, matching the sibling
    // cases above, so a projection that regressed to emitting `"5"` still fails.
    expect(
      session?.prs?.map((pr) => pr.num).sort((a, b) => Number(a) - Number(b))
    ).toEqual([5, 900]);
  });

  // A branch link declares no `prNumber`, so the FEA-2531 branch-inheritance
  // phantom is adjudicated through the branch's own PR details rather than
  // through link metadata. Pinned separately from the mixed case above so the
  // unadjudicated-keep rule can never quietly re-open that path.
  it("still drops a CWD-branch-inherited blob PR under the per-PR gate", async () => {
    installSession({
      pullRequests: [
        {
          num: 4242,
          title: "PR #4242",
          status: SessionPrLifecycleStatus.Unknown,
        },
        {
          num: 4243,
          title: "PR #4243",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [cwdBranchSourceLink(4242)],
    });

    const session = await findFirstSession();

    // #4242 is reachable from the branch the session merely checked out, so it is
    // adjudicated-and-not-authored. #4243 is spoken about by nothing at all.
    expect(session?.prs?.map((pr) => pr.num)).toEqual([4243]);
  });

  // Identity normalization (logical-QA review): a producer may hand the link a
  // `.git`-suffixed or slash-wrapped repo for the same repository the record
  // stores bare. Both sides key through `normalizeRepoFullName`, so the authored
  // link still matches its own blob entry instead of the gate dropping a real PR.
  it("matches an authored link whose repo arrived with a .git suffix", async () => {
    installSession({
      pullRequests: [
        {
          num: 512,
          title: "Blob title for #512",
          status: SessionPrLifecycleStatus.Unknown,
        },
      ],
      sourceLinks: [
        prSourceLink({
          prNumber: 512,
          relationType: SessionPrRelationType.Created,
          repositoryFullName: `${REPO}.git`,
        }),
      ],
    });

    const session = await findFirstSession();

    expect(session?.prs).toEqual([
      {
        num: 512,
        title: "Blob title for #512",
        status: SessionPrLifecycleStatus.Unknown,
      },
    ]);
  });
});
