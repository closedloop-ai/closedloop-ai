/**
 * ISS-9859: one session's PRs paginated across the parts of a chunk sequence,
 * through the real ingest (`parseDesktopAgentSessionsPayload` +
 * `agentSessionsService.upsertSessions`) against Postgres.
 *
 * The parts are the producer's real shape. A part carries EITHER a `prRefs`
 * page or a `prs` page, never both, refs pages first. The first PR-list part
 * is page 0 and carries `prRefsPaginated: false`; the pages after it carry
 * `true`; base parts carry no key.
 *
 * Lane-level suites cannot see what this pins. The blob append needs the
 * stored row the ingest reads under its locks. And every part after the first
 * meets the PR freshness gate at a TIE, because all parts of one sequence carry
 * the session's one `updatedAt`, so page 0's whole-set replace lands only
 * because the tie admits it.
 */
import { randomUUID } from "node:crypto";
import {
  MAX_SESSION_SYNC_CHUNKS,
  type SessionPR,
} from "@repo/api/src/types/agent-session";
import { LinkType } from "@repo/api/src/types/artifact";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  type PersistedSessionPrRef,
  SessionPrRelationType,
} from "@repo/api/src/types/session-artifact-link";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  buildSessionChunk,
  type ChunkSyncContext,
  createComputeTarget,
  ingestChunk,
} from "@/__tests__/utils/chunked-sync-test-helpers";
import {
  createTestOrganization,
  createTestUser,
  joinAmbientTransactionForSessionSyncWrites,
} from "@/__tests__/utils/db-helpers";
import {
  SessionPrLinkAudience,
  sessionPrLinkKindWhere,
} from "@/lib/session-pr-links";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const REPO_FULL_NAME = "acme/web";
const DATA_REVISION = 7;
const OBSERVED_AT = "2026-06-10T10:30:00.000Z";
const FIRST_SYNC_AT = "2026-06-10T11:00:00.000Z";
const SECOND_SYNC_AT = "2026-06-10T12:00:00.000Z";

type SequenceContext = ChunkSyncContext & { externalSessionId: string };
type PrListPart = Record<string, unknown>;

describeIfDb(
  "ISS-9859: paginated PR sync through the real ingest (real Postgres)",
  () => {
    it("lands every prs page and keeps every linked ref across one sequence", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-sequence");
        const total = 5;
        const parts = [
          // A base part: neither key, so both PR lanes leave the row alone.
          sequencePart(ctx, 0, total),
          {
            ...sequencePart(ctx, 1, total),
            ...pageZero({ prRefs: [prRef(1), prRef(2)] }),
          },
          {
            ...sequencePart(ctx, 2, total),
            ...laterPage({ prRefs: [prRef(3)] }),
          },
          // The prs pages. `prRefs: []` because the session defined refs; the
          // link lane must read that as "no page of refs here", never as a
          // retraction.
          {
            ...sequencePart(ctx, 3, total),
            ...laterPage({ prRefs: [], prs: [prEntry(1), prEntry(2)] }),
          },
          {
            ...sequencePart(ctx, 4, total),
            ...laterPage({ prRefs: [], prs: [prEntry(3), prEntry(4)] }),
          },
        ];

        for (const part of [
          parts[0],
          parts[1],
          parts[2],
          parts[3],
          // At-least-once delivery: the same prs page again, before the last
          // part. The blob must not grow.
          parts[3],
          parts[4],
        ]) {
          await ingestChunk(ctx, randomUUID(), part);
        }

        const stored = await readSession(ctx);
        // The sequence committed, so every part above was applied, not skipped.
        expect(stored.dataRevision).toBe(DATA_REVISION);
        expect(stored.pullRequests).toEqual(
          [1, 2, 3, 4].map((prNumber) => prEntry(prNumber))
        );
        // Both prs pages carried `prRefs: []` and neither cost a link. At this
        // tie the gate skips the link lane outright for an empty later page;
        // that the Merge arm itself deletes nothing is pinned in
        // `artifact-links/pr-links-paginated-association.integration.test.ts`.
        expect(await linkedPrNumbers(ctx, stored.artifactId)).toEqual([
          1, 2, 3,
        ]);
      });
    });

    it("re-sync: page 0 replaces the blob, so a dropped PR and an old status go", async () => {
      // The phantom this admission exists for. Page 0 ties the base part of its
      // own sequence, and before the tie admitted it, its blob CLEAR was skipped
      // and sync 2's prs page appended onto sync 1's blob:
      // `[#1 open, #2 open, #1 merged]`, with PR 2 unlinked and still rendered.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-resync");
        await firstSync(ctx);

        await syncSequence(ctx, SECOND_SYNC_AT, [
          pageZero({ prRefs: [prRef(1)] }),
          laterPage({ prRefs: [], prs: [prEntry(1, "merged")] }),
        ]);

        const stored = await readSession(ctx);
        expect(stored.pullRequests).toEqual([prEntry(1, "merged")]);
        expect(await linkedPrNumbers(ctx, stored.artifactId)).toEqual([1]);
      });
    });

    it("page 0 at a tie with no prs clears the blob when the session has no prs left", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-page-zero-clear");
        await firstSync(ctx);

        // No prs pages follow: the session's new `prs` list is empty.
        await syncSequence(ctx, SECOND_SYNC_AT, [
          pageZero({ prRefs: [prRef(1)] }),
        ]);

        const stored = await readSession(ctx);
        expect(stored.pullRequests).toBeNull();
      });
    });

    it("page 0 at a tie with prRefs: [] deletes the session's PR links", async () => {
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-page-zero-empty-refs");
        await firstSync(ctx);

        await syncSequence(ctx, SECOND_SYNC_AT, [pageZero({ prRefs: [] })]);

        const stored = await readSession(ctx);
        expect(await linkedPrNumbers(ctx, stored.artifactId)).toEqual([]);
        expect(stored.pullRequests).toBeNull();
      });
    });

    it("CONTROL: a part with no marker at a tie keeps ISS-4946's preserve", async () => {
      // Same payload as the case above minus the page-0 marker. The ISS-4946
      // tie rule still decides it: neither lane has evidence, so neither writes.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-no-marker-tie");
        await firstSync(ctx);

        await syncSequence(ctx, SECOND_SYNC_AT, [{ prRefs: [] }]);

        const stored = await readSession(ctx);
        expect(await linkedPrNumbers(ctx, stored.artifactId)).toEqual([1, 2]);
        expect(stored.pullRequests).toEqual([prEntry(1), prEntry(2)]);
      });
    });

    it("replaces rather than merges a marked part past MAX_SESSION_SYNC_CHUNKS", async () => {
      // Review (davetho): `chunk.total` is client-controlled and the wire schema
      // bounds it from below only. A marked part of a longer sequence than the
      // producer can build is handled as a whole set, so it retracts and nothing
      // accumulates.
      await joinAmbientTransactionForSessionSyncWrites(async () => {
        const ctx = await seedSequence("iss9859-over-ceiling");
        const total = MAX_SESSION_SYNC_CHUNKS + 1;

        await ingestChunk(ctx, randomUUID(), {
          ...sequencePart(ctx, 0, total),
          ...pageZero({ prRefs: [prRef(1), prRef(3)] }),
        });
        await ingestChunk(ctx, randomUUID(), {
          ...sequencePart(ctx, 1, total),
          ...laterPage({ prRefs: [prRef(2)] }),
        });

        const stored = await readSession(ctx);
        // Replace: PRs 1 and 3 are retracted. Merge would have kept all three.
        expect(await linkedPrNumbers(ctx, stored.artifactId)).toEqual([2]);
      });
    });
  }
);

/** Sync 1: PRs 1 and 2, both open, both linked. */
async function firstSync(ctx: SequenceContext): Promise<void> {
  await syncSequence(ctx, FIRST_SYNC_AT, [
    pageZero({ prRefs: [prRef(1), prRef(2)] }),
    laterPage({ prRefs: [], prs: [prEntry(1), prEntry(2)] }),
  ]);
}

/**
 * One whole sequence at `updatedAt`: a base part, then each PR-list part. The
 * base part stores `updatedAt` first, so every PR-list part meets the tie.
 */
async function syncSequence(
  ctx: SequenceContext,
  updatedAt: string,
  prListParts: PrListPart[]
): Promise<void> {
  const total = prListParts.length + 1;
  const parts = [
    sequencePart(ctx, 0, total),
    ...prListParts.map((prListPart, offset) => ({
      ...sequencePart(ctx, offset + 1, total),
      ...prListPart,
    })),
  ];
  for (const part of parts) {
    await ingestChunk(ctx, randomUUID(), { ...part, updatedAt });
  }
}

function pageZero(page: PrListPart): PrListPart {
  return { ...page, prRefsPaginated: false };
}

function laterPage(page: PrListPart): PrListPart {
  return { ...page, prRefsPaginated: true };
}

async function seedSequence(label: string): Promise<SequenceContext> {
  const organizationId = await createTestOrganization();
  const owner = await createTestUser(organizationId);
  const computeTargetId = await createComputeTarget(
    organizationId,
    owner.id,
    label
  );
  // The PR detail lane resolves a PR artifact ref only in a repository the org
  // has authority over, and a PR ref links only through that detail row.
  await withDb((db) =>
    db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${organizationId}`,
          fullName: REPO_FULL_NAME,
        }),
        owner: "acme",
        name: "web",
        htmlUrl: `https://github.com/${REPO_FULL_NAME}`,
      },
      select: { id: true },
    })
  );
  return {
    organizationId,
    userId: owner.id,
    computeTargetId,
    externalSessionId: `sess-${label}`,
  };
}

/**
 * One part of the sequence, carrying neither PR key. `artifactRefs` ride every
 * part whole, as the desktop sends them, and each PR sits on its own branch so
 * each gets its own link.
 */
function sequencePart(
  ctx: SequenceContext,
  index: number,
  total: number
): Record<string, unknown> {
  return {
    ...buildSessionChunk({
      externalSessionId: ctx.externalSessionId,
      name: "ISS-9859 paginated PRs",
      eventIds: [`evt-${index}`],
      chunk: { index, total },
      dataRevision: DATA_REVISION,
    }),
    artifactRefs: [1, 2, 3].map(pullRequestArtifactRef),
  };
}

function pullRequestArtifactRef(prNumber: number): Record<string, unknown> {
  return {
    kind: ArtifactRefTargetKind.PullRequest,
    repositoryFullName: REPO_FULL_NAME,
    prNumber,
    branchName: `feat/iss9859-pr-${prNumber}`,
    method: ArtifactRefMethod.PrCreateOutput,
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
  };
}

function prRef(prNumber: number): Record<string, unknown> {
  return {
    repositoryFullName: REPO_FULL_NAME,
    prNumber,
    relationType: SessionPrRelationType.Created,
  };
}

function prEntry(prNumber: number, status = "open"): SessionPR {
  return { num: prNumber, title: `PR #${prNumber}`, status };
}

function readSession(ctx: SequenceContext) {
  return withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: {
        computeTargetId_externalSessionId: {
          computeTargetId: ctx.computeTargetId,
          externalSessionId: ctx.externalSessionId,
        },
      },
      select: { artifactId: true, dataRevision: true, pullRequests: true },
    })
  );
}

/**
 * Every PR number this session's PR links declare, read through the production
 * kind predicate so the assertion cannot drift from what the lane writes.
 */
async function linkedPrNumbers(
  ctx: SequenceContext,
  sessionArtifactId: string
): Promise<number[]> {
  const links = await withDb((db) =>
    db.artifactLink.findMany({
      where: {
        organizationId: ctx.organizationId,
        sourceId: sessionArtifactId,
        linkType: LinkType.RelatesTo,
        ...sessionPrLinkKindWhere(SessionPrLinkAudience.Evidence),
      },
      select: { metadata: true },
    })
  );
  return links
    .flatMap((link) => {
      const metadata = link.metadata as { prRefs?: PersistedSessionPrRef[] };
      return (metadata.prRefs ?? []).map((ref) => ref.prNumber);
    })
    .sort((left, right) => left - right);
}
