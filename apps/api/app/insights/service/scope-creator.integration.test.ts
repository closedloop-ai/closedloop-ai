import { InsightsScope } from "@repo/api/src/types/insights";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactType, withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { describe, expect, it } from "vitest";
import {
  autoRollbackTransaction,
  createTestOrganization,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { fetchLossPersonGrid } from "@/app/insights/lost-work-queries";
import {
  type InsightsScopeContext,
  sessionScopeSql,
} from "@/app/insights/service/scope";
import {
  countSessions,
  fetchSessionRollup,
} from "@/app/insights/service/session-queries";

/**
 * ISS-12251 D-4 (PLN-2176 T-3.3): Insights' Me and Team scopes, and the
 * Lost-work per-engineer grid, credit a session to its creator
 * (`artifacts.created_by_id`), not to the user who recorded it
 * (`compute_targets.user_id`) nor to its Owner (`artifacts.assignee_id`).
 *
 * The corpus keeps three people apart: one session created by C, recorded by
 * R and owned by O, and one created and recorded by R. Each read answers
 * differently on each of the three columns.
 */

const describeIfDb = keys().DATABASE_URL ? describe : describe.skip;

const WINDOW_START = new Date("2026-06-01T00:00:00.000Z");
const WINDOW_END = new Date("2026-06-30T00:00:00.000Z");
const SPLIT_AT = new Date("2026-06-15T00:00:00.000Z");
const IN_WINDOW = new Date("2026-06-10T12:00:00.000Z");

type Corpus = {
  organizationId: string;
  creator: string;
  recorder: string;
  owner: string;
};

describeIfDb("Insights scope keys on Created by (ISS-12251)", () => {
  it("scopes Me to the sessions the viewer created, on the Prisma and SQL scopes", async () => {
    const { prismaCount, sqlCount } = await withCorpus(async (corpus) => {
      const ctx = context(corpus, corpus.creator, InsightsScope.Me);
      return {
        prismaCount: await countSessions(ctx, WINDOW_START, WINDOW_END),
        sqlCount: (
          await fetchSessionRollup(ctx, {
            start: WINDOW_START,
            end: WINDOW_END,
          })
        ).sessionCount,
      };
    });

    expect(prismaCount).toBe(1);
    expect(sqlCount).toBe(1);
  });

  it("scopes Team to the sessions a member created, on the Prisma and SQL scopes", async () => {
    const { prismaCount, sqlCount } = await withCorpus(async (corpus) => {
      const teamId = await withDb(async (db) => {
        const team = await db.team.create({
          data: {
            organizationId: corpus.organizationId,
            name: "Creators",
            slug: `creators-${corpus.organizationId}`,
          },
          select: { id: true },
        });
        await db.teamMember.create({
          data: { teamId: team.id, userId: corpus.creator },
          select: { id: true },
        });
        return team.id;
      });
      const ctx: InsightsScopeContext = {
        ...context(corpus, corpus.creator, InsightsScope.Team),
        teamId,
      };
      return {
        prismaCount: await countSessions(ctx, WINDOW_START, WINDOW_END),
        sqlCount: (
          await fetchSessionRollup(ctx, {
            start: WINDOW_START,
            end: WINDOW_END,
          })
        ).sessionCount,
      };
    });

    expect(prismaCount).toBe(1);
    expect(sqlCount).toBe(1);
  });

  it("credits the Lost-work per-engineer grid to each session's creator", async () => {
    const { rows, corpus } = await withCorpus(async (seeded) => ({
      corpus: seeded,
      rows: await fetchLossPersonGrid(
        sessionScopeSql(context(seeded, seeded.creator, InsightsScope.Org)),
        WINDOW_START,
        WINDOW_END,
        SPLIT_AT
      ),
    }));

    const sessionsByPerson = new Map<string | null, number>();
    for (const row of rows) {
      sessionsByPerson.set(
        row.userId,
        (sessionsByPerson.get(row.userId) ?? 0) + Number(row.sessions)
      );
    }
    expect(Object.fromEntries(sessionsByPerson)).toEqual({
      [corpus.creator]: 1,
      [corpus.recorder]: 1,
    });
  });
});

function context(
  corpus: Corpus,
  userId: string,
  scope: InsightsScope
): InsightsScopeContext {
  return { organizationId: corpus.organizationId, userId, scope };
}

function withCorpus<T>(read: (corpus: Corpus) => Promise<T>): Promise<T> {
  return autoRollbackTransaction(async () => read(await seedCorpus()));
}

async function seedCorpus(): Promise<Corpus> {
  const organizationId = await createTestOrganization();
  const [creator, recorder, owner] = await Promise.all(
    ["Creator", "Recorder", "Owner"].map((firstName) =>
      createTestUser(organizationId, { firstName, lastName: "Person" })
    )
  );
  await withDb(async (db) => {
    const computeTarget = await db.computeTarget.create({
      data: {
        organizationId,
        userId: recorder.id,
        machineName: `insights-scope-creator-${organizationId}`,
        platform: "darwin",
      },
      select: { id: true },
    });
    const createSession = async (
      label: string,
      createdById: string,
      assigneeId: string
    ) => {
      const artifact = await db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.SESSION,
          name: `insights-scope-creator-${label}`,
          status: SESSION_STATUS.INACTIVE,
          createdById,
          assigneeId,
        },
        select: { id: true },
      });
      await db.sessionDetail.create({
        data: {
          artifactId: artifact.id,
          computeTargetId: computeTarget.id,
          externalSessionId: `insights-scope-creator-${artifact.id}`,
          harness: "claude",
          sessionStartedAt: IN_WINDOW,
          sessionUpdatedAt: IN_WINDOW,
          lastActivityAt: IN_WINDOW,
        },
        select: { artifactId: true },
      });
    };
    await createSession("split", creator.id, owner.id);
    await createSession("recorder-own", recorder.id, recorder.id);
  });
  return {
    organizationId,
    creator: creator.id,
    recorder: recorder.id,
    owner: owner.id,
  };
}
