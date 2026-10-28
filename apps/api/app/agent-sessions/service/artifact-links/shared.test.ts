import { BranchLifecycleBoundaryKind } from "@repo/api/src/types/branch";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { RepositoryIdentitySource } from "./authority-source-queries";
import {
  collectBranchRefs,
  collectObservableRepositoryNames,
  collectProviderVerifiablePullRequestRefs,
  collectPullRequestRefs,
  readBranchLifecycleEventsFromMetadata,
  resolveSessionRepositoryIdentity,
  ServerRepositoryFetchAuthority,
  ServerRepositoryIdentity,
  type SessionRepositoryIdentityProbe,
  serverRepositoryFetchAuthority,
  serverRepositoryIdentity,
} from "./shared";

const REPOSITORY = "closedloop-ai/closedloop-ai";
const ORGANIZATION_ID = "019ff900-0000-7000-8000-000000000001";

describe("generic artifact-link materialization", () => {
  it("keeps prose PR refs in the PR lane while excluding them from provider-verifiable refs", () => {
    const refs = [
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "feat/regular",
        method: ArtifactRefMethod.GitCommand,
        relation: ArtifactRefRelation.Created,
      },
      {
        kind: ArtifactRefTargetKind.Branch,
        repositoryFullName: REPOSITORY,
        branchName: "feat/activity-only",
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Reviewed,
        monitoredActivityOnly: true,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: 6060,
        method: ArtifactRefMethod.PrReviewCommand,
        relation: ArtifactRefRelation.Reviewed,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: 6061,
        method: ArtifactRefMethod.McpToolCall,
        relation: ArtifactRefRelation.Reviewed,
        monitoredActivityOnly: true,
      },
      {
        kind: ArtifactRefTargetKind.PullRequest,
        repositoryFullName: REPOSITORY,
        prNumber: 6062,
        method: ArtifactRefMethod.PrMentionInProse,
        relation: ArtifactRefRelation.Referenced,
      },
    ] satisfies SyncedArtifactRef[];

    expect(collectBranchRefs(refs).map((ref) => ref.branchName)).toEqual([
      "feat/regular",
    ]);
    expect(collectPullRequestRefs(refs).map((ref) => ref.prNumber)).toEqual([
      6060, 6062,
    ]);
    expect(
      collectProviderVerifiablePullRequestRefs(refs).map((ref) => ref.prNumber)
    ).toEqual([6060]);
  });
});

/**
 * ISS-7012/ISS-7062: this reader was the SECOND hand-rolled member-wise parse in
 * the service and now delegates to the canonical `parseJsonArray`. It had no
 * direct coverage, so the member-wise contract it has always had was pinned
 * nowhere — a future edit could have restored the all-or-nothing collapse (one
 * version-skewed event discarding an entire branch's lifecycle history) with the
 * suite still green.
 */
describe("readBranchLifecycleEventsFromMetadata", () => {
  it("keeps the readable events surrounding an unreadable one", () => {
    // The corrupt members sit BETWEEN two valid ones: an all-valid fixture reads
    // identically under a member-wise and an all-or-nothing parse. The expected
    // kinds are written out here rather than derived from the reader.
    //
    // Note what does NOT belong in this fixture: an unrecognized `kind` string.
    // `branchLifecycleBoundaryKindSchema` ends in `.catch(UnknownEvidence)`, so
    // a kind from a newer desktop is READABLE by design (the cross-repo
    // version-skew rule), not corrupt. The members that genuinely fail are ones
    // that break the event OBJECT shape.
    const events = readBranchLifecycleEventsFromMetadata({
      branchLifecycleEvents: [
        { kind: BranchLifecycleBoundaryKind.SessionStart },
        "not-an-event-object",
        { kind: BranchLifecycleBoundaryKind.BranchWrite, evidenceId: "" },
        { kind: BranchLifecycleBoundaryKind.PrRaised },
      ],
    });

    expect(events.map((event) => event.kind)).toEqual([
      BranchLifecycleBoundaryKind.SessionStart,
      BranchLifecycleBoundaryKind.PrRaised,
    ]);
  });

  it("degrades an unknown kind from a newer client rather than dropping the event", () => {
    // The compatibility half of the contract, pinned so a future tightening of
    // the schema cannot silently turn version skew into data loss.
    const events = readBranchLifecycleEventsFromMetadata({
      branchLifecycleEvents: [{ kind: "a_kind_this_build_does_not_model" }],
    });

    expect(events.map((event) => event.kind)).toEqual([
      BranchLifecycleBoundaryKind.UnknownEvidence,
    ]);
  });

  it("reads absent, non-object, and non-array metadata as no events rather than throwing", () => {
    expect(readBranchLifecycleEventsFromMetadata(null)).toEqual([]);
    expect(readBranchLifecycleEventsFromMetadata("not-an-object")).toEqual([]);
    expect(readBranchLifecycleEventsFromMetadata({})).toEqual([]);
    expect(
      readBranchLifecycleEventsFromMetadata({
        branchLifecycleEvents: "not-an-array",
      })
    ).toEqual([]);
  });
});

describe("collectObservableRepositoryNames (PLN-1775 M1)", () => {
  const OTHER_REPOSITORY = "closedloop-ai/other";

  function sessionWithRefs(refs: SyncedArtifactRef[]) {
    return [
      {
        externalSessionId: "ext-1",
        artifactRefs: refs,
      },
    ] as unknown as Parameters<typeof collectObservableRepositoryNames>[0];
  }

  function branchRef(repositoryFullName: string): SyncedArtifactRef {
    return {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName,
      branchName: "feat/x",
      method: ArtifactRefMethod.GitCommand,
      relation: ArtifactRefRelation.Created,
    };
  }

  function proseBranchRef(repositoryFullName: string): SyncedArtifactRef {
    return {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName,
      branchName: "feat/prose-only",
      method: ArtifactRefMethod.BranchMentionInProse,
      relation: ArtifactRefRelation.Referenced,
    };
  }

  function prosePullRequestRef(repositoryFullName: string): SyncedArtifactRef {
    return {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName,
      prNumber: 95_639,
      method: ArtifactRefMethod.PrMentionInProse,
      relation: ArtifactRefRelation.Referenced,
    };
  }

  function identityProbe(
    entries: [
      string,
      {
        repositoryId?: string | null;
        providerRepositoryId?: string;
        identityConflict?: boolean;
        identitySources?: readonly RepositoryIdentitySource[];
      },
    ][],
    probedNames: readonly string[] = entries.map(([fullName]) => fullName)
  ): SessionRepositoryIdentityProbe {
    return {
      authorities: new Map(
        entries.map(([fullName, authority]) => [
          fullName,
          {
            repositoryId: authority.repositoryId ?? null,
            ...(authority.providerRepositoryId
              ? { providerRepositoryId: authority.providerRepositoryId }
              : {}),
            ...(authority.identityConflict ? { identityConflict: true } : {}),
            authorities: [],
            identitySources: new Set(authority.identitySources ?? []),
          },
        ])
      ),
      probedNames: new Set(probedNames),
    };
  }

  it("names a repository the server holds no record of", () => {
    // The whole point of ISS-7403: with no installation, every source the
    // authority read consults is empty, so this is the only place the repos an
    // org actually works in can be named at all.
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([branchRef(REPOSITORY)]),
        identityProbe([], [REPOSITORY])
      )
    ).toEqual([REPOSITORY]);
  });

  it("names nothing for a repository no read covered", () => {
    // A discovery candidate is a repository the server was ASKED about and had
    // no record of. A name nobody looked up is not that, and recording it would
    // put a claim behind a name whose identity was never in question.
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([branchRef(REPOSITORY)]),
        identityProbe([], [])
      )
    ).toEqual([]);
  });

  it("covers PR refs, not only branch refs", () => {
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([
          {
            kind: ArtifactRefTargetKind.PullRequest,
            repositoryFullName: OTHER_REPOSITORY,
            prNumber: 42,
            method: ArtifactRefMethod.PrReviewCommand,
            relation: ArtifactRefRelation.Reviewed,
          },
        ]),
        identityProbe([], [OTHER_REPOSITORY])
      )
    ).toEqual([OTHER_REPOSITORY]);
  });

  it("keeps prose PR refs in the PR lane but excludes them from observation candidates", () => {
    const proseRef = prosePullRequestRef(OTHER_REPOSITORY);

    expect(
      collectPullRequestRefs([proseRef]).map((ref) => ref.prNumber)
    ).toEqual([95_639]);
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([proseRef]),
        identityProbe([], [OTHER_REPOSITORY])
      )
    ).toEqual([]);
  });

  it("keeps prose branch refs in the branch lane but excludes them from observation candidates", () => {
    const proseRef = proseBranchRef(REPOSITORY);

    expect(collectBranchRefs([proseRef]).map((ref) => ref.branchName)).toEqual([
      "feat/prose-only",
    ]);
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([proseRef]),
        identityProbe([], [REPOSITORY])
      )
    ).toEqual([]);
  });

  it("skips a repository that already has an installation row, a provider id, or a contested identity", () => {
    // Each of these is a repo the server already knows; recording it as a
    // discovery candidate would put a second identity claim behind a name that
    // already has one.
    expect(
      collectObservableRepositoryNames(
        sessionWithRefs([
          branchRef("acme/installed"),
          branchRef("acme/public"),
          branchRef("acme/contested"),
          branchRef("acme/unknown"),
        ]),
        identityProbe(
          [
            ["acme/installed", { repositoryId: "repo-1" }],
            ["acme/public", { providerRepositoryId: "9001" }],
            ["acme/contested", { identityConflict: true }],
          ],
          ["acme/installed", "acme/public", "acme/contested", "acme/unknown"]
        )
      )
    ).toEqual(["acme/unknown"]);
  });

  /**
   * ISS-9181 Step 1: the filter body above is now a named predicate with a
   * SECOND caller, the monitored-activity target classifier, which reads it as
   * "this organization has no claim on this repository" and acknowledges the
   * session on the strength of it. Each disjunct therefore needs its own row:
   * the observation lane only ever asked for the whole answer, so a disjunct
   * silently dropped from the OR would still have kept every test above green
   * on the composite fixture.
   */
  describe("serverRepositoryIdentity", () => {
    it.each([
      {
        name: "absent entry for a name that WAS read for",
        authority: null,
        expected: ServerRepositoryIdentity.None,
      },
      {
        name: "installation row id",
        authority: { repositoryId: "repo-1" },
        expected: ServerRepositoryIdentity.Held,
      },
      {
        name: "provider repository id",
        authority: { providerRepositoryId: "9001" },
        expected: ServerRepositoryIdentity.Held,
      },
      {
        name: "contested identity",
        authority: { identityConflict: true },
        expected: ServerRepositoryIdentity.Held,
      },
    ])("answers $expected for $name", ({ authority, expected }) => {
      const probe = identityProbe(authority ? [[REPOSITORY, authority]] : [], [
        REPOSITORY,
      ]);

      expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(expected);
    });

    /**
     * ISS-9181 code review: the two ways of holding no entry are NOT the same
     * fact, and the classifier acknowledges — discarding the desktop's evidence
     * for good — on only one of them. A boolean predicate could not tell them
     * apart, so this pair is what the third value exists for.
     */
    it("separates a name read for and not found from a name nobody read for", () => {
      const probe = identityProbe(
        [[REPOSITORY, { repositoryId: "repo-1" }]],
        [REPOSITORY, OTHER_REPOSITORY]
      );

      expect(serverRepositoryIdentity(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryIdentity.None
      );
      expect(
        serverRepositoryIdentity(
          identityProbe([[REPOSITORY, { repositoryId: "repo-1" }]]),
          OTHER_REPOSITORY
        )
      ).toBe(ServerRepositoryIdentity.NotProbed);
    });
  });

  /**
   * PLN-2061 M1: identity and fetch authority are different questions, and the
   * monitored-activity classifier had been asking the first while acting on
   * the answer to the second. Every repository below answers `Held` to
   * `serverRepositoryIdentity` — that is the point, and it is why a test that
   * only checked identity could not have caught this.
   */
  describe("serverRepositoryFetchAuthority", () => {
    it.each([
      {
        source: RepositoryIdentitySource.Installation,
        expected: ServerRepositoryFetchAuthority.Held,
      },
      {
        source: RepositoryIdentitySource.Public,
        expected: ServerRepositoryFetchAuthority.Held,
      },
      {
        // Copied out of the `head.repo` object embedded in a read aimed at the
        // BASE repository, so nothing here ever reached this one.
        source: RepositoryIdentitySource.PullRequestHead,
        expected: ServerRepositoryFetchAuthority.None,
      },
      {
        // A `repos.get` that reached this repository ONCE, through whichever
        // credential was at hand — not standing access.
        source: RepositoryIdentitySource.Observed,
        expected: ServerRepositoryFetchAuthority.None,
      },
    ])(
      "answers $expected for an identity from $source",
      ({ source, expected }) => {
        const probe = identityProbe([
          [
            REPOSITORY,
            { providerRepositoryId: "9001", identitySources: [source] },
          ],
        ]);

        expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
          ServerRepositoryIdentity.Held
        );
        expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
          expected
        );
      }
    );

    /**
     * TWO repositories in ONE probe, because one cannot tell a per-repository
     * predicate from one answering the same way for the whole probe — a
     * single-repository fixture stays green under the exact mutation this
     * exists to catch.
     */
    it("separates an observation-only repository from an installation-backed one", () => {
      const probe = identityProbe([
        [
          REPOSITORY,
          {
            repositoryId: "repo-1",
            identitySources: [RepositoryIdentitySource.Installation],
          },
        ],
        [
          OTHER_REPOSITORY,
          {
            providerRepositoryId: "204033634",
            identitySources: [RepositoryIdentitySource.Observed],
          },
        ],
      ]);

      expect(serverRepositoryIdentity(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryIdentity.Held
      );
      expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.Held
      );
      expect(serverRepositoryFetchAuthority(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.None
      );
    });

    /**
     * ISS-9182 review r4053480977. A PR opened from a fork writes the fork's
     * `full_name` and `id` into `pull_request_detail` from the `head.repo`
     * object embedded in a read of the BASE repository — so the org holds a
     * PR-head identity for a repository it has no installation on, no public
     * row for, and has never read. Paired with an installation-backed name in
     * ONE probe for the reason the observation case above is: a single-
     * repository fixture cannot tell a per-source verdict from a global one.
     */
    it("separates a fork's PR-head identity from an installation-backed one", () => {
      const probe = identityProbe([
        [
          REPOSITORY,
          {
            repositoryId: "repo-1",
            identitySources: [RepositoryIdentitySource.Installation],
          },
        ],
        [
          OTHER_REPOSITORY,
          {
            providerRepositoryId: "5826",
            identitySources: [RepositoryIdentitySource.PullRequestHead],
          },
        ],
      ]);

      expect(serverRepositoryIdentity(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryIdentity.Held
      );
      expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.Held
      );
      expect(serverRepositoryFetchAuthority(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.None
      );
    });

    it("holds authority when an observation sits beside a credentialed source", () => {
      const probe = identityProbe([
        [
          REPOSITORY,
          {
            providerRepositoryId: "9001",
            identitySources: [
              RepositoryIdentitySource.Observed,
              RepositoryIdentitySource.Public,
            ],
          },
        ],
      ]);

      expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.Held
      );
    });

    /**
     * A name nobody read for must never report authority: the gate this feeds
     * lets the PR lane claim a target, and claiming one on an unread name is
     * the same unanswered-question defect its identity sibling guards.
     */
    it("separates a name read for and answering nothing from a name nobody read for", () => {
      const probe = identityProbe(
        [
          [
            REPOSITORY,
            {
              providerRepositoryId: "204033634",
              identitySources: [RepositoryIdentitySource.Observed],
            },
          ],
        ],
        [REPOSITORY]
      );

      expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.None
      );
      expect(serverRepositoryFetchAuthority(probe, OTHER_REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.NotProbed
      );
    });
  });
});

/**
 * ISS-9181 Step 2 turns "the predicate says no identity" into an
 * ACKNOWLEDGEMENT, which is only safe if the two arms cannot overlap: an
 * absent entry has to be the whole of "no identity", never a present entry
 * that happens to carry none. `reconcileAuthorityRows` and
 * `mergeIdentityOnlyRows` read as if they guarantee that, but reading is not
 * proof, so drive the real resolver over every row shape it accepts and check
 * the invariant on what comes back.
 */
describe("resolveSessionRepositoryIdentity never emits an identity-less entry", () => {
  function sessionWithRefs(refs: SyncedArtifactRef[]) {
    return [
      { externalSessionId: "ext-1", artifactRefs: refs },
    ] as unknown as Parameters<typeof resolveSessionRepositoryIdentity>[2];
  }

  const AUTHORITY_SESSIONS = sessionWithRefs([
    {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName: REPOSITORY,
      branchName: "feat/x",
      method: ArtifactRefMethod.GitCommand,
      relation: ArtifactRefRelation.Created,
    },
  ]);
  const IDENTITY_ONLY_SESSIONS = sessionWithRefs([
    {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName: REPOSITORY,
      prNumber: 6060,
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredActivityOnly: true,
    },
  ]);

  function authoritySourceRow(id: string, githubRepoId: string | null) {
    return {
      id,
      githubRepoId,
      fullName: REPOSITORY,
      defaultBranchName: null,
      defaultBranchAvailability: null,
      defaultBranchCompleteness: null,
      defaultBranchReason: null,
      defaultBranchSource: null,
      defaultBranchMechanism: null,
      defaultBranchTrigger: null,
      defaultBranchCredentialType: null,
      defaultBranchCredentialOwnerId: null,
      defaultBranchObservationKey: null,
      defaultBranchObservedAt: null,
      defaultBranchEventAt: null,
    };
  }

  it.each([
    {
      name: "an authority row with no provider id",
      sessions: AUTHORITY_SESSIONS,
      rows: [authoritySourceRow("repo-1", null)],
    },
    {
      name: "an authority row carrying a provider id",
      sessions: AUTHORITY_SESSIONS,
      rows: [authoritySourceRow("repo-1", "9001")],
    },
    {
      name: "an identity-only installation row",
      sessions: IDENTITY_ONLY_SESSIONS,
      rows: [
        { repositoryId: "repo-1", githubRepoId: "9001", fullName: REPOSITORY },
      ],
    },
    {
      name: "two identity-only rows claiming one name",
      sessions: IDENTITY_ONLY_SESSIONS,
      rows: [
        { repositoryId: "repo-1", githubRepoId: "9001", fullName: REPOSITORY },
        { repositoryId: "repo-2", githubRepoId: "9002", fullName: REPOSITORY },
      ],
    },
    {
      // The source that has no `repositoryId` at all: a public, PR-head, or
      // verified-observed row. The org holds identity for the repository with
      // no active installation anywhere, which is the shape the installation
      // lookup alone answered "no identity" for.
      name: "an identity-only row carrying only a provider id",
      sessions: IDENTITY_ONLY_SESSIONS,
      rows: [
        { repositoryId: null, githubRepoId: "9001", fullName: REPOSITORY },
      ],
    },
    {
      // ISS-9181 re-review: a row the read FOUND that pins no id at all. The
      // three sources with no `repositoryId` can carry a blank `github_repo_id`,
      // no query filters a blank, and `?.trim() || undefined` drops it — so the
      // entry reached `serverRepositoryIdentity` carrying nothing and was read
      // as `None`, acknowledging the Session and discarding its evidence for a
      // repository the server demonstrably holds a row for.
      name: "an identity-only row whose provider id is blank",
      sessions: IDENTITY_ONLY_SESSIONS,
      rows: [{ repositoryId: null, githubRepoId: "  ", fullName: REPOSITORY }],
    },
    {
      name: "an identity-only row carrying neither id",
      sessions: IDENTITY_ONLY_SESSIONS,
      rows: [{ repositoryId: null, githubRepoId: null, fullName: REPOSITORY }],
    },
  ])("holds for $name", async ({ sessions, rows }) => {
    const tx = { $queryRaw: vi.fn().mockResolvedValue(rows) };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      sessions
    );

    expect([...probe.authorities.keys()]).toEqual([REPOSITORY]);
    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
  });

  /**
   * ISS-9181 review (#6718): only the PUBLIC arm does not filter a blank
   * `github_repo_id`, so a blank public row arrives BEFORE the PR-head row
   * carrying a real one. Folding row-by-row let the blank latch
   * `identityConflict`, and the conflict early-return then made the real id
   * unreachable — a repository the server CAN identify came back conflicted,
   * retry-owned and withheld indefinitely, which is the hold this PR exists to
   * remove.
   *
   * `serverRepositoryIdentity` cannot see this: `identityConflict` reads as
   * `Held` exactly like a real id does. The assertion has to be the identity
   * itself.
   */
  it("lets a real id from a later row clear a blank row's provisional conflict", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        { repositoryId: null, githubRepoId: "  ", fullName: REPOSITORY },
        { repositoryId: null, githubRepoId: "9001", fullName: REPOSITORY },
      ]),
    };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      IDENTITY_ONLY_SESSIONS
    );

    const authority = probe.authorities.get(REPOSITORY);
    expect(authority?.providerRepositoryId).toBe("9001");
    expect(authority?.identityConflict).toBeUndefined();
    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
  });

  it("still latches a genuine disagreement between two real ids", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        { repositoryId: null, githubRepoId: "9001", fullName: REPOSITORY },
        { repositoryId: null, githubRepoId: "9002", fullName: REPOSITORY },
      ]),
    };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      IDENTITY_ONLY_SESSIONS
    );

    expect(probe.authorities.get(REPOSITORY)?.identityConflict).toBe(true);
  });

  /**
   * ISS-9181 code review: the identity lane read `github_installation_repositories`
   * and nothing else, so an organization that reaches a repository through a
   * public row, a PR head, or a verified observation — with no active install
   * for it — came back absent from the map, and the classifier read that
   * absence as an answer and acknowledged the Session on it. The other three
   * sources are asked only for the names the installation lookup left
   * unanswered, so the common path still costs one statement per chunk.
   */
  it("asks the other identity sources only for the names no installation row answered", async () => {
    const queryRaw = vi
      .fn()
      .mockResolvedValueOnce([])
      .mockResolvedValue([
        { repositoryId: null, githubRepoId: "9001", fullName: REPOSITORY },
      ]);

    const probe = await resolveSessionRepositoryIdentity(
      { $queryRaw: queryRaw } as never,
      ORGANIZATION_ID,
      IDENTITY_ONLY_SESSIONS
    );

    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
    // The installation lookup, then public + PR-head + verified-observed.
    expect(queryRaw).toHaveBeenCalledTimes(4);
    expect(
      queryRaw.mock.calls
        .slice(1)
        .map(([query]) => query.strings.join(""))
        .join("")
    ).toContain("head_repository_full_name");
  });

  it("reports a name it read for and did not find as probed, not unknown", async () => {
    const probe = await resolveSessionRepositoryIdentity(
      { $queryRaw: vi.fn().mockResolvedValue([]) } as never,
      ORGANIZATION_ID,
      IDENTITY_ONLY_SESSIONS
    );

    expect(probe.authorities.size).toBe(0);
    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.None
    );
  });

  /**
   * ISS-9181 Step 5. A repository named ONLY by a `monitoredActivityOnly`
   * BRANCH ref reached neither read: `collectBranchRefs` excludes it and the
   * identity collector took PR refs only. Its absence from the map therefore
   * meant "never looked up", which the acknowledgement predicate would have
   * read as "no identity" and acked a Session on. It joins the identity read
   * and only that one: the default-branch authority columns answer a different
   * question and this name has no use for them. (#5103's whole-history filter
   * is no longer the reason — ISS-6452 indexed that arm; see
   * `readLockedIdentityRows`.)
   */
  it("looks up a transport-only branch ref's repository, in the identity read alone", async () => {
    const tx = {
      $queryRaw: vi.fn().mockResolvedValue([
        {
          repositoryId: "repo-1",
          githubRepoId: "9001",
          fullName: REPOSITORY,
        },
      ]),
    };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      sessionWithRefs([
        {
          kind: ArtifactRefTargetKind.Branch,
          repositoryFullName: REPOSITORY,
          branchName: "feat/monitored-only",
          method: ArtifactRefMethod.McpToolCall,
          relation: ArtifactRefRelation.Reviewed,
          monitoredActivityOnly: true,
        },
      ])
    );

    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
    // The installation lookup answered, so nothing else is asked; the authority
    // read is four statements per chunk and never runs for this name.
    expect(tx.$queryRaw).toHaveBeenCalledTimes(1);
  });
});

/**
 * PLN-2061 M1, end to end through the real resolver.
 *
 * The hand-built probes elsewhere prove what the predicate does with a source
 * set; they cannot prove the set is built from the right query's rows. A
 * reader that labelled the observed arm `Public` would pass every one of them
 * and go on conferring fetch authority on exactly the repositories this
 * milestone exists to withhold it from — so the arms have to answer for
 * different repositories and be told apart by their answers.
 */
describe("resolveSessionRepositoryIdentity carries each identity source", () => {
  const OBSERVED_ONLY_REPOSITORY = "prisma/prisma-engines";

  function identityOnlyPullRequestRef(
    repositoryFullName: string,
    prNumber: number
  ): SyncedArtifactRef {
    return {
      kind: ArtifactRefTargetKind.PullRequest,
      repositoryFullName,
      prNumber,
      method: ArtifactRefMethod.McpToolCall,
      relation: ArtifactRefRelation.Reviewed,
      monitoredActivityOnly: true,
    };
  }

  it("answers authority for an installed repository and withholds it for an observed-only one", async () => {
    const tx = {
      $queryRaw: vi.fn().mockImplementation((query: { strings: string[] }) => {
        const statement = query.strings.join(" ");
        if (statement.includes("github_installation_repositories")) {
          return [
            {
              repositoryId: "repo-1",
              githubRepoId: "9001",
              fullName: REPOSITORY,
            },
          ];
        }
        if (statement.includes("github_observed_repository")) {
          return [
            {
              repositoryId: null,
              githubRepoId: "204033634",
              fullName: OBSERVED_ONLY_REPOSITORY,
            },
          ];
        }
        return [];
      }),
    };

    const probe = await resolveSessionRepositoryIdentity(
      tx as never,
      ORGANIZATION_ID,
      [
        {
          externalSessionId: "ext-1",
          artifactRefs: [
            identityOnlyPullRequestRef(REPOSITORY, 6060),
            identityOnlyPullRequestRef(OBSERVED_ONLY_REPOSITORY, 5860),
          ],
        },
      ] as unknown as Parameters<typeof resolveSessionRepositoryIdentity>[2]
    );

    // Identity is Held for BOTH — the verified observation carries a real
    // provider id — which is why identity could never have gated the PR lane.
    expect(serverRepositoryIdentity(probe, REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
    expect(serverRepositoryIdentity(probe, OBSERVED_ONLY_REPOSITORY)).toBe(
      ServerRepositoryIdentity.Held
    );
    expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
      ServerRepositoryFetchAuthority.Held
    );
    expect(
      serverRepositoryFetchAuthority(probe, OBSERVED_ONLY_REPOSITORY)
    ).toBe(ServerRepositoryFetchAuthority.None);
  });
});

/**
 * PLN-2061 M1 on the AUTHORITY read, a second tagging site the suite above
 * cannot reach: `collectNormalizedRepositoryNames` excludes
 * `monitoredActivityOnly` refs, so those sessions drive
 * `readLockedIdentityRows` alone and `readLockedAuthorityRows` never runs. An
 * ordinary branch ref drives the authority read, whose four arms attach
 * `source` in their own place — and swapping the `Observed` tag there for a
 * credentialed one left every other test in this change green (ISS-9182
 * review), which would restore exactly the defect the gate exists to remove.
 */
describe("resolveSessionRepositoryIdentity carries each authority source", () => {
  const UPSTREAM_REPOSITORY = "prisma/prisma-engines";
  const INSTALLATION_ARM = "FROM github_installation_repositories repository";

  function authorityRow(fullName: string, githubRepoId: string) {
    return {
      id: `row-${fullName}`,
      githubRepoId,
      fullName,
      defaultBranchName: null,
      defaultBranchAvailability: null,
      defaultBranchCompleteness: null,
      defaultBranchReason: null,
      defaultBranchSource: null,
      defaultBranchMechanism: null,
      defaultBranchTrigger: null,
      defaultBranchCredentialType: null,
      defaultBranchCredentialOwnerId: null,
      defaultBranchObservationKey: null,
      defaultBranchObservedAt: null,
      defaultBranchEventAt: null,
    };
  }

  function authorityBranchRef(repositoryFullName: string): SyncedArtifactRef {
    return {
      kind: ArtifactRefTargetKind.Branch,
      repositoryFullName,
      branchName: "feat/x",
      method: ArtifactRefMethod.GitCommand,
      relation: ArtifactRefRelation.Created,
    };
  }

  /**
   * Every case answers the installation arm for one repository and the arm
   * under test for a SECOND one, in ONE probe: a single-repository fixture
   * cannot tell a per-arm tag from one the whole read hands out, so it stays
   * green under the swap this exists to catch.
   */
  it.each([
    {
      arm: "FROM public_repositories repository",
      source: RepositoryIdentitySource.Public,
      expected: ServerRepositoryFetchAuthority.Held,
    },
    {
      arm: "FROM pull_request_detail pull_request",
      source: RepositoryIdentitySource.PullRequestHead,
      expected: ServerRepositoryFetchAuthority.None,
    },
    {
      // PLN-1775 M4's own worked case, and the one the PR-lane gate turns on:
      // default-branch authority from a verified observation and no
      // installation anywhere.
      arm: "FROM github_observed_repository repository",
      source: RepositoryIdentitySource.Observed,
      expected: ServerRepositoryFetchAuthority.None,
    },
  ])(
    "tags an authority row from $source and answers $expected",
    async ({ arm, source, expected }) => {
      const tx = {
        $queryRaw: vi
          .fn()
          .mockImplementation((query: { strings: string[] }) => {
            const statement = query.strings.join(" ");
            if (statement.includes(INSTALLATION_ARM)) {
              return [authorityRow(REPOSITORY, "9001")];
            }
            if (statement.includes(arm)) {
              return [authorityRow(UPSTREAM_REPOSITORY, "204033634")];
            }
            return [];
          }),
      };

      const probe = await resolveSessionRepositoryIdentity(
        tx as never,
        ORGANIZATION_ID,
        [
          {
            externalSessionId: "ext-1",
            artifactRefs: [
              authorityBranchRef(REPOSITORY),
              authorityBranchRef(UPSTREAM_REPOSITORY),
            ],
          },
        ] as unknown as Parameters<typeof resolveSessionRepositoryIdentity>[2]
      );

      expect(probe.authorities.get(REPOSITORY)?.identitySources).toEqual(
        new Set([RepositoryIdentitySource.Installation])
      );
      expect(
        probe.authorities.get(UPSTREAM_REPOSITORY)?.identitySources
      ).toEqual(new Set([source]));
      expect(serverRepositoryFetchAuthority(probe, REPOSITORY)).toBe(
        ServerRepositoryFetchAuthority.Held
      );
      expect(serverRepositoryFetchAuthority(probe, UPSTREAM_REPOSITORY)).toBe(
        expected
      );
    }
  );
});
