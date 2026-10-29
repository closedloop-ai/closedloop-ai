import {
  ArtifactRefMethod,
  SessionArtifactLinkKind,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { describe, expect, it, vi } from "vitest";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { sessionPullRequestDetailKey } from "./pull-request-details";

describe("session PR set convergence", () => {
  it("downgrades branch-owned canonical rows on present-empty replay", async () => {
    const update = vi.fn().mockResolvedValue({ id: "link-1" });
    const updateMany = vi.fn().mockResolvedValue({ count: 1 });
    const executeRaw = vi.fn().mockResolvedValue(1);
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: vi.fn().mockResolvedValue([]),
      branchMaterializationRetry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifactLink: {
        updateMany,
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([
          {
            id: "link-1",
            metadata: { ...canonicalMetadata(), branchLinked: true },
          },
        ]),
        update,
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      [],
      new Map()
    );

    // ISS-8145: the downgrade is ONE `unnest` statement carrying each link's own
    // metadata, instead of an `update` per link or an `updateMany` per distinct
    // metadata. The metadata pinned here is byte-for-byte what it was — only the
    // statement carrying it changed.
    expect(downgradeWrites(executeRaw)).toEqual([
      {
        id: "link-1",
        metadata: {
          branchLinked: true,
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
        },
      },
    ]);
    // The per-row writes must be gone, not merely joined by a batched sibling.
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("downgrades links on DIFFERENT branches in ONE statement, each keeping its own metadata", async () => {
    // The single-link fixture above cannot observe the batching at all: one link
    // produces the same statement either way. Production reaches several —
    // `artifactLink` is unique on (sourceId, targetId, linkType), so a session
    // with evidence on three branches holds three `branchLinked` rows.
    //
    // The branch fields are the point (codex review). `branchOnlyMetadata`
    // strips PR identity but PRESERVES `branchName` and
    // `branchRepositoryFullName`, so every one of these links downgrades to a
    // DIFFERENT value. Grouping by serialized metadata therefore collapsed
    // nothing here and issued one statement per link — the per-item writer
    // ISS-8145 exists to remove. One statement carrying per-id payloads is the
    // only shape that satisfies both.
    const update = vi.fn().mockResolvedValue({ id: "link-1" });
    const updateMany = vi.fn().mockResolvedValue({ count: 3 });
    const executeRaw = vi.fn().mockResolvedValue(1);
    const branchNames = ["feat/one", "feat/two", "feat/three"];
    const tx = {
      $executeRaw: executeRaw,
      $queryRaw: vi.fn().mockResolvedValue([]),
      branchMaterializationRetry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifactLink: {
        updateMany,
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue(
          branchNames.map((branchName, index) => ({
            id: `link-${index + 1}`,
            metadata: {
              ...canonicalMetadata(),
              branchLinked: true,
              branchName,
            },
          }))
        ),
        update,
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      [],
      new Map()
    );

    // ONE statement for three distinct results, not three.
    expect(downgradeStatementCount(executeRaw)).toBe(1);
    expect(downgradeWrites(executeRaw)).toEqual(
      branchNames.map((branchName, index) => ({
        id: `link-${index + 1}`,
        metadata: {
          branchLinked: true,
          branchName,
          linkKind: SessionArtifactLinkKind.SessionBranch,
          linkKinds: [SessionArtifactLinkKind.SessionBranch],
        },
      }))
    );
    expect(update).not.toHaveBeenCalled();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("preserves a temporarily unresolved member and converges deterministically", async () => {
    const existingMetadata = canonicalMetadata();
    let currentMetadata: Record<string, unknown> = existingMetadata;
    const upsert = vi.fn().mockImplementation((args) => {
      currentMetadata = args.create.metadata;
      return Promise.resolve({ id: "link-1" });
    });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      branchMaterializationRetry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockImplementation((args) => {
          if (args.where?.metadata?.path?.[0] === "branchLinked") {
            return Promise.resolve([]);
          }
          return Promise.resolve([
            { targetId: "branch-1", metadata: currentMetadata },
          ]);
        }),
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
        upsert,
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ metadata: null }),
        update: vi.fn().mockResolvedValue({ artifactId: "session-1" }),
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];
    const refs = [1, 2].map((prNumber) => ({
      repositoryFullName: "acme/web",
      prNumber,
      relationType: SessionPrRelationType.Created,
    }));

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      refs,
      detailMap([2])
    );
    const firstRefs = upsert.mock.calls[0][0].create.metadata.prRefs;
    expect(firstRefs.map((ref: { prNumber: number }) => ref.prNumber)).toEqual([
      1, 2,
    ]);

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      refs,
      detailMap([1, 2])
    );
    expect(upsert.mock.calls[1][0].create.metadata.prRefs).toEqual(firstRefs);
  });

  it("re-derives the branch kind when a snapshot retracts to prose-only (ISS-5823)", async () => {
    // Codex P1 review. The PR kinds are cleared and recomputed every pass, but
    // `session_branch` was inherited through `collectLinkKinds`. So a link that
    // once carried two strong refs — and earned `session_branch` from that
    // multi-PR shape — kept that kind after a fresher snapshot retracted them
    // and left only a prose mention. `topLevelLinkKind` reads the survivor and
    // emits `session_branch`, and the branch lane's own predicate readmits the
    // prose-only session into the Branches corpus and the 1/N cost divisor,
    // straight past the exclusion this ticket added.
    //
    // The fixture is the RETRACTION, not a fresh prose link: a link born prose
    // never had `session_branch` to inherit and passes either way.
    const upsert = vi.fn().mockResolvedValue({ id: "link-1" });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      branchMaterializationRetry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockImplementation((args) => {
          if (args.where?.metadata?.path?.[0] === "branchLinked") {
            return Promise.resolve([]);
          }
          // The STALE prior shape: two strong refs, so `session_branch` is
          // present and was legitimately earned at the time.
          return Promise.resolve([
            { targetId: "branch-1", metadata: canonicalMetadata() },
          ]);
        }),
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
        upsert,
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({ metadata: null }),
        update: vi.fn().mockResolvedValue({ artifactId: "session-1" }),
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      [
        {
          repositoryFullName: "acme/web",
          prNumber: 1,
          relationType: SessionPrRelationType.Referenced,
          method: ArtifactRefMethod.PrMentionInProse,
        },
      ],
      detailMap([1])
    );

    const written = upsert.mock.calls[0][0].create.metadata;
    expect(written.linkKinds).not.toContain(
      SessionArtifactLinkKind.SessionBranch
    );
    expect(written.linkKind).toBe(SessionArtifactLinkKind.SessionPrProse);
  });

  it("dedupes unresolved refs on the canonical PR identity (ISS-7060)", async () => {
    // The stored `_unresolvedPrRefs` are raw wire values — nothing normalizes
    // them on the way in — so the retry list has to dedupe the way every other
    // PR-identity comparison in this lane does. `Acme/Web#7`, `acme/web#7` and
    // `acme/web.git#7` are ONE PR to `sessionPrIdentityKey`; a raw
    // `repositoryFullName#prNumber` key made them three entries that each
    // retry the same PR.
    const update = vi.fn().mockResolvedValue({ artifactId: "session-1" });
    const tx = {
      $executeRaw: vi.fn().mockResolvedValue(1),
      $queryRaw: vi.fn().mockResolvedValue([]),
      branchMaterializationRetry: {
        findMany: vi.fn().mockResolvedValue([]),
      },
      artifactLink: {
        updateMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
        findMany: vi.fn().mockResolvedValue([]),
        update: vi.fn().mockResolvedValue({ id: "link-1" }),
        upsert: vi.fn().mockResolvedValue({ id: "link-1" }),
      },
      sessionDetail: {
        findUnique: vi.fn().mockResolvedValue({
          metadata: {
            _unresolvedPrRefs: [
              { repositoryFullName: "Acme/Web", prNumber: 7 },
            ],
          },
        }),
        update,
      },
    } as unknown as Parameters<typeof persistSessionPrArtifactLinks>[0];

    await persistSessionPrArtifactLinks(
      tx,
      "org-1",
      "session-1",
      [
        {
          repositoryFullName: "acme/web",
          prNumber: 7,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: "acme/web.git",
          prNumber: 7,
          relationType: SessionPrRelationType.Created,
        },
        {
          repositoryFullName: "acme/other",
          prNumber: 9,
          relationType: SessionPrRelationType.Created,
        },
      ],
      // Empty: nothing resolves, so every ref lands in the retry list.
      new Map()
    );

    expect(update).toHaveBeenCalledTimes(1);
    expect(update.mock.calls[0][0].data.metadata._unresolvedPrRefs).toEqual([
      { repositoryFullName: "Acme/Web", prNumber: 7 },
      { repositoryFullName: "acme/other", prNumber: 9 },
    ]);
  });
});

/** The downgrade's own statement, picked out of the flow's other raw writes. */
function downgradeCalls(
  executeRaw: ReturnType<typeof vi.fn>
): [unknown, string[], string[], string][] {
  return executeRaw.mock.calls.filter((call) =>
    (call[0] as string[]).join("").includes("UPDATE artifact_links")
  ) as [unknown, string[], string[], string][];
}

function downgradeStatementCount(executeRaw: ReturnType<typeof vi.fn>): number {
  return downgradeCalls(executeRaw).length;
}

/** The (id, metadata) pairs the downgrade statement actually carries. */
function downgradeWrites(
  executeRaw: ReturnType<typeof vi.fn>
): { id: string; metadata: unknown }[] {
  const calls = downgradeCalls(executeRaw);
  return calls.flatMap(([, ids, metadata]) =>
    ids.map((id, index) => ({ id, metadata: JSON.parse(metadata[index]) }))
  );
}

function canonicalMetadata() {
  return {
    linkKind: SessionArtifactLinkKind.SessionBranch,
    linkKinds: [
      SessionArtifactLinkKind.SessionBranch,
      SessionArtifactLinkKind.SessionPrSet,
    ],
    prRefs: [1, 2].map((prNumber) => ({
      repositoryFullName: "acme/web",
      prNumber,
      relationTypes: [SessionPrRelationType.Created],
    })),
  };
}

function detailMap(numbers: number[]) {
  return new Map(
    numbers.map((number) => [
      sessionPullRequestDetailKey("acme/web", number),
      { prDetailId: `pr-${number}`, branchArtifactId: "branch-1" },
    ])
  );
}
