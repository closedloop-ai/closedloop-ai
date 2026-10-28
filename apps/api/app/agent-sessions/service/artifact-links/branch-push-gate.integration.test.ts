import {
  ArtifactType,
  BranchPushSource,
  LinkType,
} from "@repo/api/src/types/artifact";
import { CollaboratorArtifactType } from "@repo/api/src/types/artifact-collaborators";
import { BranchStatus } from "@repo/api/src/types/branch";
import { BranchPersonProvider } from "@repo/api/src/types/branch-identity";
import {
  ArtifactRefMethod,
  ArtifactRefRelation,
  ArtifactRefTargetKind,
  BRANCH_PUSH_METHOD_VALUES,
  SessionArtifactLinkKind,
  SessionPrRelationType,
  type SyncedArtifactRef,
} from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import { persistedGitHubRepositoryAuthority } from "@/__tests__/fixtures/repository-default-authority";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "@/app/artifacts/collaborators/service";
import { SessionIngestWorkBudget } from "../ingest-work-budget";
import { persistSessionBranchArtifactLinks } from "./branch-links";
import {
  BRANCH_RETRY_WRITE_CHUNK_SIZE,
  BranchMaterializationRetryState,
} from "./branch-materialization-retry";
import { drainBranchMaterializationRetries } from "./branch-materialization-retry-drain";
import { BranchMaterializationRetryTerminalReason } from "./branch-materialization-retry-monitor";
import {
  BranchMaterializationRetryPolicy,
  BranchMaterializationRetryReason,
} from "./branch-materialization-retry-policy";
import { persistSessionPrArtifactLinks } from "./pr-links";
import { persistSessionPullRequestDetails } from "./pull-request-details";
import { resolveSessionRepositoryIdentity } from "./shared";

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const REPO_FULL_NAME = "acme/web";
const OBSERVED_AT = "2026-08-20T12:00:00.000Z";
const PUSHED_AT = "2026-08-20T13:00:00.000Z";
const GIT_PUSH_METHOD = BRANCH_PUSH_METHOD_VALUES[0];

/**
 * ISS-8148 (PRD-683 Ruling 2 + D7) — the acceptance chain, end to end against
 * real Postgres: a local-only branch defers (no row, no link, a durable
 * `BranchMaterializationRetry` paper trail per ISS-8001), the SAME ref set
 * re-synced after a push materializes and links retroactively, a same-batch
 * {branch ref + PR ref} defers in the branch lane and materializes only through
 * the gated PR lanes, and a legacy no-evidence row keeps its session links and
 * heals with zero deletions.
 */
describeIfDb("session branch push gate (ISS-8148, real Postgres)", () => {
  it("defers a local-only branch, then links retroactively on the push re-sync", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await seedSessionFixture("iss8148-defer");
      const branchName = "feat/iss8148-local";

      await syncBranchLane(fx, [localOnlyRef(branchName)]);

      expect(await branchRowCount(fx.organizationId, branchName)).toBe(0);
      expect(await sessionLinkCount(fx)).toBe(0);
      // The deferral is DURABLE (ISS-8001 retry store), not dependent on the
      // desktop replaying the evicted ref: one pending retry row per identity.
      expect(await retryRowCount(fx, branchName)).toBe(1);

      // The desktop re-sends the FULL ref set on the next sync; after the
      // push it now carries a push-method ref too.
      await syncBranchLane(fx, [localOnlyRef(branchName), pushRef(branchName)]);

      const branch = await readBranchRow(fx.organizationId, branchName);
      expect(branch).toMatchObject({
        firstPushedAt: new Date(PUSHED_AT),
        pushSource: BranchPushSource.Session,
      });
      expect(await sessionLinkCount(fx)).toBe(1);
      const owner = await withDb((db) =>
        db.artifact.findUniqueOrThrow({
          where: { id: fx.sessionArtifactId },
          select: { createdById: true },
        })
      );
      const branchId = await withDb((db) =>
        db.branchDetail.findFirstOrThrow({
          where: { organizationId: fx.organizationId, branchName },
          select: { artifactId: true },
        })
      );
      const readCollaborators = () =>
        artifactCollaboratorsService.readBatch(fx.organizationId, {
          artifactType: CollaboratorArtifactType.Branch,
          artifactIds: [branchId.artifactId],
        });
      const collaborators = await readCollaborators();
      expect(collaborators.results[0]?.collaborators.people).toEqual([
        expect.objectContaining({
          provider: BranchPersonProvider.ClosedLoop,
          userId: owner.createdById,
        }),
      ]);
      await syncBranchLane(fx, [localOnlyRef(branchName), pushRef(branchName)]);
      expect(await sessionLinkCount(fx)).toBe(1);
      expect(await readCollaborators()).toEqual(collaborators);
    });
  });

  it("advances updatedAt only when a batched push wins the earliest timestamp", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await seedSessionFixture("iss9278-updated-at");
      const branchName = "feat/iss9278-push";
      await syncBranchLane(fx, [pushRef(branchName)]);
      const old = new Date("2026-01-01T00:00:00Z");
      await withDb((db) =>
        db.branchDetail.updateMany({
          where: { organizationId: fx.organizationId, branchName },
          data: { firstPushedAt: null, updatedAt: old },
        })
      );
      await syncBranchLane(fx, [pushRef(branchName)]);
      const read = () =>
        withDb((db) =>
          db.branchDetail.findFirstOrThrow({
            where: { organizationId: fx.organizationId, branchName },
            select: { updatedAt: true, firstPushedAt: true },
          })
        );
      const updated = await read();
      expect(updated.updatedAt.getTime()).toBeGreaterThan(old.getTime());
      expect(updated.firstPushedAt).toEqual(new Date(PUSHED_AT));
      await syncBranchLane(fx, [pushRef(branchName)]);
      expect(await read()).toEqual(updated);
    });
  });

  it("keeps same-batch PR head evidence behind the gated PR lanes in production order", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await seedSessionFixture("iss8148-lane");
      const branchName = "feat/iss8148-pr";
      const refs: SyncedArtifactRef[] = [
        localOnlyRef(branchName),
        {
          kind: ArtifactRefTargetKind.PullRequest,
          repositoryFullName: REPO_FULL_NAME,
          prNumber: 7,
          branchName,
          method: ArtifactRefMethod.PrCreateOutput,
          relation: ArtifactRefRelation.Created,
          observedAt: OBSERVED_AT,
        },
      ];

      await withDb(async (db) => {
        const authority = await resolveAuthority(db, fx.organizationId, refs);
        // Production order (`session-slice-links.ts`) runs the branch lane
        // before PR detail/link. A same-batch PR ref must not let that ungated branch
        // lane create identity-less `branchLinked` evidence.
        await persistSessionBranchArtifactLinks(
          db,
          fx.organizationId,
          null,
          fx.sessionArtifactId,
          refs,
          authority
        );
        expect(await branchRowCount(fx.organizationId, branchName)).toBe(0);
        expect(await sessionLinkCount(fx)).toBe(0);
        expect(await retryRowCount(fx, branchName)).toBe(1);

        const pullRequestDetails = await persistSessionPullRequestDetails(
          db,
          fx.organizationId,
          null,
          fx.sessionArtifactId,
          refs,
          authority,
          { shouldUpdatePullRequestLinks: true }
        );
        await persistSessionPrArtifactLinks(
          db,
          fx.organizationId,
          fx.sessionArtifactId,
          [
            {
              repositoryFullName: REPO_FULL_NAME,
              prNumber: 7,
              relationType: SessionPrRelationType.Created,
            },
          ],
          pullRequestDetails.details
        );
      });

      const branch = await readBranchRow(fx.organizationId, branchName);
      expect(branch).toMatchObject({
        firstPushedAt: new Date(OBSERVED_AT),
        pushSource: BranchPushSource.Session,
      });
      expect(await sessionLinkCount(fx)).toBe(1);
      expect(await readSessionBranchLinkMetadata(fx, branchName)).toMatchObject(
        {
          linkKinds: expect.arrayContaining([
            SessionArtifactLinkKind.SessionBranch,
            SessionArtifactLinkKind.SessionPr,
          ]),
          prNumber: 7,
          prRefs: [
            {
              repositoryFullName: REPO_FULL_NAME,
              prNumber: 7,
              relationTypes: [SessionPrRelationType.Created],
            },
          ],
          repositoryFullName: REPO_FULL_NAME,
        }
      );
      expect(
        (
          (await readSessionBranchLinkMetadata(fx, branchName)) as Record<
            string,
            unknown
          >
        ).branchLinked
      ).toBeUndefined();
      // The branch lane's local-only deferral is cleared by the gated PR link
      // write, so the retry drain cannot later convert it to branch-only
      // evidence.
      expect(await retryRowCount(fx, branchName)).toBe(0);
    });
  });

  it("keeps linking to a legacy no-evidence row and heals it with zero deletions", async () => {
    await autoRollbackTransaction(async () => {
      const fx = await seedSessionFixture("iss8148-legacy");
      const branchName = "feat/iss8148-legacy";
      await withDb(async (db) => {
        const artifact = await db.artifact.create({
          data: {
            organizationId: fx.organizationId,
            type: ArtifactType.Branch,
            name: branchName,
            status: BranchStatus.Open,
          },
          select: { id: true },
        });
        // A pre-gate legacy row: materialized with NO push evidence.
        await db.branchDetail.create({
          data: {
            artifactId: artifact.id,
            organizationId: fx.organizationId,
            repositoryFullName: REPO_FULL_NAME,
            branchName,
            firstPushedAt: null,
            pushSource: null,
          },
          select: { artifactId: true },
        });
      });

      // D7: the legacy row keeps RECEIVING session links (row-exists path —
      // `createWhenAbsent: false` still resolves an existing row).
      await syncBranchLane(fx, [localOnlyRef(branchName)]);
      expect(await branchRowCount(fx.organizationId, branchName)).toBe(1);
      expect(await sessionLinkCount(fx)).toBe(1);
      expect(
        (await readBranchRow(fx.organizationId, branchName))?.firstPushedAt
      ).toBeNull();

      // Push evidence arrives → the row heals in place; nothing was deleted.
      await syncBranchLane(fx, [pushRef(branchName)]);
      expect(await branchRowCount(fx.organizationId, branchName)).toBe(1);
      expect(await readBranchRow(fx.organizationId, branchName)).toMatchObject({
        firstPushedAt: new Date(PUSHED_AT),
        pushSource: BranchPushSource.Session,
      });
      expect(await sessionLinkCount(fx)).toBe(1);
    });
  });
});

/**
 * ISS-8186 (davetho, #6080) — the per-session materialization budget's
 * OVERFLOW path, end to end against real Postgres rather than a transaction
 * double.
 *
 * The unit coverage for this path drives a tx double and asserts on SQL shape,
 * so it can prove the lane chunks and what it intended to write, and cannot
 * prove that Postgres ACCEPTS the chunked raw enqueue or that what it stored can
 * be claimed and drained into a branch artifact plus a session link. A
 * PostgreSQL/Prisma or drain-contract regression would discard every overflow
 * ref with those unit tests still green. Everything below therefore runs against
 * the real database and the real cron drain.
 *
 * The population is deliberately more than `BranchMaterializationsPerSession`
 * PUSH-QUALIFYING identities: every ref carries push evidence, so the gate would
 * admit all of them and only the budget can be what defers the tail.
 */
describeIfDb(
  "session branch materialization budget overflow (ISS-8186, real Postgres)",
  () => {
    it("defers the over-budget tail durably, and the cron drain settles every deferred identity", async () => {
      await autoRollbackTransaction(
        async () => {
          const fx = await seedSessionFixture("iss8186-overflow");
          const branchNames = overflowBranchNames(BUDGET + OVERFLOW);

          await syncBranchLane(fx, branchNames.map(pushRef));

          // The bound is a deferral, not a truncation, so both halves are
          // asserted: the lane materialized exactly the budget INLINE, and every
          // identity past it is durable in the retry store rather than gone.
          expect(await branchRowTotal(fx.organizationId)).toBe(BUDGET);
          expect(await sessionLinkCount(fx)).toBe(BUDGET);
          expect(await retryRowTotal(fx)).toBe(OVERFLOW);

          // The cron drain, unmocked, past the enqueue's own initial backoff.
          const summary = await drainBranchMaterializationRetries(
            afterRetryBackoff(),
            OVERFLOW
          );

          // Settles: claimed, materialized, and the retry rows deleted — not
          // rescheduled, not dead-lettered, not left claimed.
          expect(summary).toMatchObject({
            claimed: OVERFLOW,
            succeeded: OVERFLOW,
            rescheduled: 0,
            terminal: 0,
            deadLettered: 0,
            failed: 0,
          });
          // Drains INTO the branch artifact AND the session link, which is the
          // pair the double could not evidence.
          expect(await branchRowTotal(fx.organizationId)).toBe(
            BUDGET + OVERFLOW
          );
          expect(await sessionLinkCount(fx)).toBe(BUDGET + OVERFLOW);
          expect(await retryRowTotal(fx)).toBe(0);
        },
        { maxWait: HEAVY_CASE_TX_MS, timeout: HEAVY_CASE_TX_MS }
      );
    });

    it("leaves PR-vouched branch refs to the PR-detail retry path, not the branch lane overflow", async () => {
      await autoRollbackTransaction(
        async () => {
          const fx = await seedSessionFixture("iss8186-prvouch");
          const vouched = "feat/iss8186-pr-vouched";
          // The budget's worth of push-qualifying identities first, so the one
          // that follows lands in the DEFERRED tail. Its own branch ref carries
          // no push evidence at all: the PR ref naming it as head is owned by
          // the gated PR-detail retry path, not this branch lane.
          const refs: SyncedArtifactRef[] = [
            ...overflowBranchNames(BUDGET).map(pushRef),
            localOnlyRef(vouched),
            {
              kind: ArtifactRefTargetKind.PullRequest,
              repositoryFullName: REPO_FULL_NAME,
              prNumber: 8186,
              branchName: vouched,
              method: ArtifactRefMethod.PrCreateOutput,
              relation: ArtifactRefRelation.Created,
              observedAt: OBSERVED_AT,
            },
          ];

          await syncBranchLane(fx, refs);

          // Deferred by the budget, not by the gate: the branch lane persisted
          // the local-only branch aggregate without upgrading it from the PR ref.
          expect(await branchRowCount(fx.organizationId, vouched)).toBe(0);
          expect(await retryRowCount(fx, vouched)).toBe(1);

          const summary = await drainBranchMaterializationRetries(
            afterRetryBackoff(),
            1
          );

          // The drain still judges it local-only. PR-head evidence that can
          // create a Branch travels through the PR-detail aggregate instead.
          expect(summary).toMatchObject({ succeeded: 0, rescheduled: 1 });
          expect(await branchRowCount(fx.organizationId, vouched)).toBe(0);
          expect(await sessionLinkCount(fx)).toBe(BUDGET);
          expect(await retryRowCount(fx, vouched)).toBe(1);
        },
        { maxWait: HEAVY_CASE_TX_MS, timeout: HEAVY_CASE_TX_MS }
      );
    });

    it("accepts an enqueue that spans more than one bulk-write statement", async () => {
      await autoRollbackTransaction(
        async () => {
          const fx = await seedSessionFixture("iss8186-chunked");
          const branchNames = overflowBranchNames(BUDGET + OVER_CEILING);

          await syncBranchLane(fx, branchNames.map(pushRef));

          // The fixture is only discriminating if the deferred tail really does
          // span more than one statement, so assert that against the real chunk
          // width rather than assume it: as ONE `VALUES` list this row count is
          // past the bind ceiling and Postgres refuses it outright, taking the
          // whole transaction with it before any retry row is durable.
          expect(OVER_CEILING).toBeGreaterThan(BRANCH_RETRY_WRITE_CHUNK_SIZE);
          // Postgres accepted every chunk and no row was lost between them.
          expect(await retryRowTotal(fx)).toBe(OVER_CEILING);
          expect(await branchRowTotal(fx.organizationId)).toBe(BUDGET);
        },
        { maxWait: HEAVY_CASE_TX_MS, timeout: HEAVY_CASE_TX_MS }
      );
    });
  }
);

/**
 * ISS-8229 (codex, #6140) — reviving a condition-terminal row has to restart the
 * retry HORIZON, not only the attempt counter, and only real Postgres can show
 * it. `nextRetryAt` measures `MaxHorizonMs` from the row's `created_at`, and the
 * enqueue's `ON CONFLICT DO UPDATE` is the only thing that can move that column;
 * a transaction double can prove which value the statement bound and cannot
 * prove the database applied it.
 */
describeIfDb(
  "branch materialization retry revival (ISS-8229, real Postgres)",
  () => {
    it("restarts the horizon on revival, so the first retryable drain reschedules instead of dead-lettering", async () => {
      await autoRollbackTransaction(async () => {
        const fx = await seedSessionFixture("iss8229-revive");
        const branchName = "feat/iss8229-revived";

        // A local-only branch defers durably (ISS-8148), giving a real row.
        await syncBranchLane(fx, [localOnlyRef(branchName)]);
        expect(await retryRowCount(fx, branchName)).toBe(1);

        // Age it into exactly the state the ticket is about: a condition-terminal
        // deferral whose creation stamp is already past the horizon.
        const staleCreatedAt = new Date(
          Date.now() - BranchMaterializationRetryPolicy.MaxHorizonMs - DAY_MS
        );
        await withDb((db) =>
          db.branchMaterializationRetry.updateMany({
            where: {
              organizationId: fx.organizationId,
              sourceArtifactId: fx.sessionArtifactId,
              repositoryFullName: REPO_FULL_NAME,
              branchName,
            },
            data: {
              state: BranchMaterializationRetryState.Terminal,
              reason: BranchMaterializationRetryTerminalReason.DefaultBranch,
              attempts: 4,
              createdAt: staleCreatedAt,
            },
          })
        );

        // The later payload that revives it.
        await syncBranchLane(fx, [localOnlyRef(branchName)]);

        const revivedRow = await readRetryRow(fx, branchName);
        expect(revivedRow?.state).toBe(BranchMaterializationRetryState.Pending);
        expect(revivedRow?.attempts).toBe(0);

        // The branch is still local-only, so the drain's own result is the
        // ordinary retryable one. With a stale anchor this row dead-letters here
        // after a single attempt and the revival buys nothing. Asserted BEFORE
        // the anchor itself, so what fails first is the behaviour rather than
        // the column that explains it.
        const summary = await drainBranchMaterializationRetries(
          afterRetryBackoff(),
          1
        );

        expect(summary).toMatchObject({
          claimed: 1,
          rescheduled: 1,
          deadLettered: 0,
          terminal: 0,
          failed: 0,
        });
        const rescheduled = await readRetryRow(fx, branchName);
        expect(rescheduled?.state).toBe(
          BranchMaterializationRetryState.Pending
        );
        expect(rescheduled?.reason).toBe(
          BranchMaterializationRetryReason.AuthorityUnavailable
        );
        // The anchor the reschedule was computed against, read back from the
        // column the ON CONFLICT actually wrote.
        expect(revivedRow?.createdAt.getTime()).toBeGreaterThan(
          staleCreatedAt.getTime()
        );
      });
    });
  }
);

type SessionFixture = {
  organizationId: string;
  sessionArtifactId: string;
};

/** The inline allowance the overflow cases are defined relative to. */
const BUDGET = SessionIngestWorkBudget.BranchMaterializationsPerSession;

/**
 * A deferred tail that fits one bulk-write statement, kept small because each
 * identity the drain settles is its own claim transaction.
 */
const OVERFLOW = 7;

/**
 * A deferred tail that does NOT fit one bulk-write statement, sized against the
 * ceiling REAL Postgres actually enforces on this statement rather than the one
 * the chunk width reserves against.
 *
 * The unit coverage's first-over-the-line count is the first row count past
 * `POSTGRES_MAX_BIND_PARAMETERS` — the SIGNED-i16 ceiling a Prisma-BUILT
 * statement meets — and the chunk width is deliberately conservative against
 * that. But a `$queryRaw` is passed through verbatim, so it does not fail until
 * the 65,535 wire limit, which `branch-materialization-retry.ts` already says in
 * as many words: measured here at the then-14-bind tuple, 2,341 rows as ONE
 * statement were accepted by Postgres, and it took 4,682 before the driver
 * reported `08P01 bind message has 13 parameter formats but 0 parameters` — the
 * wire protocol's u16 parameter count wrapping.
 *
 * ISS-8229 widened the tuple to 15 binds (`created_at` became an explicit
 * incoming column), which moves the wire threshold DOWN to
 * `ceil(65_535 / 15) = 4,369` and leaves this count comfortably past it at
 * 70,230 parameters. So the count below is still one the statement genuinely
 * cannot be issued whole at, which is what makes "Postgres accepts it chunked" a
 * claim rather than a restatement; the small unit-side count would have asserted
 * nothing here, staying green with the chunking removed.
 */
const OVER_CEILING = 4682;

/**
 * Prisma's 5 s transaction default is not enough for these row counts. Spent
 * TWICE per test — as `maxWait` and again as `timeout` — so 2x this has to fit
 * the tier's 30 s `testTimeout`, or Vitest reaps the test first and leaves the
 * transaction running detached (ISS-8553). Worst measured here is 6.55 s.
 */
const HEAVY_CASE_TX_MS = 12_000;

const DAY_MS = 24 * 60 * 60 * 1000;

/** Distinct push-qualifying identities, zero-padded so the order is stable. */
function overflowBranchNames(count: number): string[] {
  return Array.from(
    { length: count },
    (_, index) => `feat/iss8186-${String(index).padStart(5, "0")}`
  );
}

/** A drain instant past the initial backoff the enqueue schedules rows behind. */
function afterRetryBackoff(): Date {
  return new Date(
    Date.now() + BranchMaterializationRetryPolicy.BaseDelayMs * 2
  );
}

function localOnlyRef(branchName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPO_FULL_NAME,
    branchName,
    method: ArtifactRefMethod.GitCommand,
    relation: ArtifactRefRelation.Created,
    observedAt: OBSERVED_AT,
  };
}

function pushRef(branchName: string): SyncedArtifactRef {
  return {
    kind: ArtifactRefTargetKind.Branch,
    repositoryFullName: REPO_FULL_NAME,
    branchName,
    method: GIT_PUSH_METHOD,
    relation: ArtifactRefRelation.Output,
    observedAt: PUSHED_AT,
  };
}

async function seedSessionFixture(slug: string): Promise<SessionFixture> {
  const organizationId = await createTestOrganization();
  const user = await createTestUser(organizationId);
  return withDb(async (db) => {
    const session = await db.artifact.create({
      data: {
        organizationId,
        type: ArtifactType.Session,
        name: `session-${slug}`,
        status: SESSION_STATUS.ACTIVE,
        // Ingest stamps the syncing user as creator (session-slice-detail-write),
        // and a push's person is that creator (ISS-12251).
        createdById: user.id,
      },
      select: { id: true },
    });
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: user.id,
        machineName: `machine-${slug}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    await db.sessionDetail.create({
      data: {
        artifactId: session.id,
        computeTargetId: computeTarget.id,
        externalSessionId: `ext-${slug}`,
        harness: "claude",
        sessionStartedAt: new Date(OBSERVED_AT),
        sessionUpdatedAt: new Date(OBSERVED_AT),
        lastActivityAt: new Date(OBSERVED_AT),
      },
      select: { artifactId: true },
    });
    await db.publicRepository.create({
      data: {
        organizationId,
        ...persistedGitHubRepositoryAuthority({
          githubRepoId: `repo-${session.id}`,
          fullName: REPO_FULL_NAME,
        }),
        owner: "acme",
        name: "web",
        htmlUrl: `https://github.com/${REPO_FULL_NAME}`,
      },
      select: { id: true },
    });
    return { organizationId, sessionArtifactId: session.id };
  });
}

type LaneDb = Parameters<Parameters<typeof withDb>[0]>[0];

function resolveAuthority(
  db: LaneDb,
  organizationId: string,
  refs: SyncedArtifactRef[]
) {
  return resolveSessionRepositoryIdentity(db, organizationId, [
    { artifactRefs: refs } as Parameters<
      typeof resolveSessionRepositoryIdentity
    >[2][number],
  ]).then((probe) => probe.authorities);
}

async function syncBranchLane(
  fx: SessionFixture,
  refs: SyncedArtifactRef[]
): Promise<void> {
  await withDb(async (db) => {
    const authority = await resolveAuthority(db, fx.organizationId, refs);
    await persistSessionBranchArtifactLinks(
      db,
      fx.organizationId,
      null,
      fx.sessionArtifactId,
      refs,
      authority
    );
  });
}

function branchRowCount(
  organizationId: string,
  branchName: string
): Promise<number> {
  return withDb((db) =>
    db.branchDetail.count({
      where: { organizationId, repositoryFullName: REPO_FULL_NAME, branchName },
    })
  );
}

function readBranchRow(organizationId: string, branchName: string) {
  return withDb((db) =>
    db.branchDetail.findFirst({
      where: { organizationId, repositoryFullName: REPO_FULL_NAME, branchName },
      select: { artifactId: true, firstPushedAt: true, pushSource: true },
    })
  );
}

function sessionLinkCount(fx: SessionFixture): Promise<number> {
  return withDb((db) =>
    db.artifactLink.count({
      where: {
        organizationId: fx.organizationId,
        sourceId: fx.sessionArtifactId,
        linkType: LinkType.RelatesTo,
        target: { type: ArtifactType.Branch },
      },
    })
  );
}

function readSessionBranchLinkMetadata(fx: SessionFixture, branchName: string) {
  return withDb((db) =>
    db.artifactLink
      .findFirst({
        where: {
          organizationId: fx.organizationId,
          sourceId: fx.sessionArtifactId,
          linkType: LinkType.RelatesTo,
          target: {
            branch: { repositoryFullName: REPO_FULL_NAME, branchName },
          },
        },
        select: { metadata: true },
      })
      .then((link) => link?.metadata ?? null)
  );
}

/** Every branch row this org has, not just one identity's. */
function branchRowTotal(organizationId: string): Promise<number> {
  return withDb((db) =>
    db.branchDetail.count({
      where: { organizationId, repositoryFullName: REPO_FULL_NAME },
    })
  );
}

/** Every retry row still queued for this session, whatever its identity. */
function retryRowTotal(fx: SessionFixture): Promise<number> {
  return withDb((db) =>
    db.branchMaterializationRetry.count({
      where: {
        organizationId: fx.organizationId,
        sourceArtifactId: fx.sessionArtifactId,
      },
    })
  );
}

function retryRowCount(
  fx: SessionFixture,
  branchName: string
): Promise<number> {
  return withDb((db) =>
    db.branchMaterializationRetry.count({
      where: {
        organizationId: fx.organizationId,
        sourceArtifactId: fx.sessionArtifactId,
        repositoryFullName: REPO_FULL_NAME,
        branchName,
      },
    })
  );
}

function readRetryRow(fx: SessionFixture, branchName: string) {
  return withDb((db) =>
    db.branchMaterializationRetry.findFirst({
      where: {
        organizationId: fx.organizationId,
        sourceArtifactId: fx.sessionArtifactId,
        repositoryFullName: REPO_FULL_NAME,
        branchName,
      },
      select: {
        state: true,
        reason: true,
        attempts: true,
        createdAt: true,
      },
    })
  );
}
