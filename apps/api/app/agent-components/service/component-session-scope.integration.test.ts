import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { withDb } from "@repo/database";
import { v7 as uuidv7 } from "uuid";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestSessionDetail,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { readComponentFrequency } from "./component-frequency";
import {
  buildComponentSessionScope,
  buildComponentUsageScope,
} from "./component-session-scope";

const tracker = createCommittedTestOrganizationTracker();
const rollback = tracker.run;
afterEach(() => tracker.cleanup());
const describeWithDatabase = process.env.DATABASE_URL
  ? describe
  : describe.skip;

describeWithDatabase(
  "component population before Sessions facets and paging",
  () => {
    it("includes whole-family aliases, orphan and differently linked usages while excluding another identity", async () =>
      rollback(async () => {
        const fixture = await seedSessions(5);
        const hash = "a".repeat(64);
        const own = await inventory(
          fixture,
          AgentComponentKind.Skill,
          "deploy",
          { contentHash: hash }
        );
        await inventory(fixture, AgentComponentKind.Skill, "release", {
          contentHash: hash,
        });
        const other = await inventory(
          fixture,
          AgentComponentKind.Skill,
          "other"
        );
        await usages([
          {
            agentSessionId: fixture.sessions[0]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: " Deploy ",
            agentComponentId: own,
          },
          {
            agentSessionId: fixture.sessions[1]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "release",
            agentComponentId: null,
          },
          {
            agentSessionId: fixture.sessions[2]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "deploy",
            agentComponentId: other,
          },
          {
            agentSessionId: fixture.sessions[3]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "other",
            agentComponentId: own,
          },
          {
            agentSessionId: fixture.sessions[4]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "",
            agentComponentId: own,
          },
        ]);
        const where = await buildComponentSessionScope(
          fixture.organizationId,
          `${AgentComponentKind.Skill}::${hash}`
        );
        const rows = await withDb((db) =>
          db.sessionDetail.findMany({
            where,
            select: { artifactId: true },
            orderBy: { artifactId: "asc" },
          })
        );
        expect(rows.map((row) => row.artifactId).sort()).toEqual(
          [0, 1, 2, 4].map((index) => fixture.sessions[index]).sort()
        );
        const usageWhere = await buildComponentUsageScope(
          fixture.organizationId,
          `${AgentComponentKind.Skill}::${hash}`
        );
        expect(
          await withDb((db) =>
            db.agentComponentSessionUsage.count({ where: usageWhere })
          )
        ).toBe(4);
        const page = await withDb((db) =>
          db.sessionDetail.findMany({
            where: { AND: [where, { artifact: { id: fixture.sessions[2] } }] },
            take: 1,
            select: { artifactId: true },
          })
        );
        expect(page.map((row) => row.artifactId)).toEqual([
          fixture.sessions[2],
        ]);
      }));
    it("reuses the plugin child identity rollup including orphan children and excluding tombstoned owners", async () =>
      rollback(async () => {
        const fixture = await seedSessions(4);
        await inventory(fixture, AgentComponentKind.Plugin, "pack", {
          packId: "pack",
        });
        const live = await inventory(
          fixture,
          AgentComponentKind.Skill,
          "child",
          { packId: "pack" }
        );
        const dead = await inventory(
          fixture,
          AgentComponentKind.Skill,
          "child",
          { packId: "old-pack", uninstalledAt: new Date() }
        );
        await usages([
          {
            agentSessionId: fixture.sessions[0]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "child",
            agentComponentId: live,
          },
          {
            agentSessionId: fixture.sessions[1]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: " CHILD ",
            agentComponentId: null,
          },
          {
            agentSessionId: fixture.sessions[2]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "child",
            agentComponentId: dead,
          },
          {
            agentSessionId: fixture.sessions[3]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "unrelated",
            agentComponentId: live,
          },
        ]);
        const where = await buildComponentSessionScope(
          fixture.organizationId,
          `${AgentComponentKind.Plugin}::pack`
        );
        const rows = await withDb((db) =>
          db.sessionDetail.findMany({ where, select: { artifactId: true } })
        );
        expect(rows.map((row) => row.artifactId).sort()).toEqual(
          fixture.sessions.slice(0, 2).sort()
        );
      }));
    it("aggregates canonical usage once on UTC session-start days and excludes another organization", async () =>
      rollback(async () => {
        const fixture = await seedSessions(2);
        const foreign = await seedSessions(1);
        await usages([
          ...fixture.sessions.map((agentSessionId) => ({
            agentSessionId,
            componentKind: AgentComponentKind.Skill,
            componentKey: "deploy",
            agentComponentId: null,
          })),
          {
            agentSessionId: foreign.sessions[0]!,
            componentKind: AgentComponentKind.Skill,
            componentKey: "deploy",
            agentComponentId: null,
          },
        ]);
        await withDb(async (db) => {
          await db.agentSessionTokenUsage.createMany({
            data: ["claude-opus-4-6", "claude-sonnet-4-6"].map((model) => ({
              agentSessionId: fixture.sessions[0]!,
              model,
              inputTokens: 10n,
            })),
          });
          await db.sessionDetail.update({
            where: { artifactId: fixture.sessions[0] },
            data: { sessionStartedAt: new Date("2026-10-18T23:30:00-02:00") },
            select: { artifactId: true },
          });
          await db.sessionDetail.update({
            where: { artifactId: fixture.sessions[1] },
            data: { sessionStartedAt: new Date("2026-10-18T00:00:00Z") },
            select: { artifactId: true },
          });
          await db.sessionDetail.update({
            where: { artifactId: foreign.sessions[0] },
            data: { sessionStartedAt: new Date("2026-10-19T00:00:00Z") },
            select: { artifactId: true },
          });
        });
        expect(
          await readComponentFrequency(
            fixture.organizationId,
            `${AgentComponentKind.Skill}::deploy`,
            2,
            new Date("2026-10-19T12:00:00Z")
          )
        ).toEqual({
          windowDays: 2,
          points: [
            { day: "2026-10-18", invocations: 1 },
            { day: "2026-10-19", invocations: 1 },
          ],
        });
      }));
    it("resolves usage-only fingerprints, rejects unknown routes and never crosses tenants", async () =>
      rollback(async () => {
        const fixture = await seedSessions(2);
        const hash = "b".repeat(64);
        await usages(
          fixture.sessions.map((agentSessionId) => ({
            agentSessionId,
            componentKind: AgentComponentKind.Subagent,
            componentKey: "design-critic",
            componentVersionHash: hash,
            agentComponentId: null,
          }))
        );
        const where = await buildComponentSessionScope(
          fixture.organizationId,
          `${AgentComponentKind.Subagent}::${hash}`
        );
        expect(await withDb((db) => db.sessionDetail.count({ where }))).toBe(2);
        const foreign = await tracker.create();
        expect(
          await withDb(async (db) =>
            db.sessionDetail.count({
              where: await buildComponentSessionScope(
                foreign,
                `${AgentComponentKind.Subagent}::${hash}`
              ),
            })
          )
        ).toBe(0);
        expect(
          await withDb(async (db) =>
            db.sessionDetail.count({
              where: await buildComponentSessionScope(
                fixture.organizationId,
                "invalid"
              ),
            })
          )
        ).toBe(0);
      }));
  }
);

async function seedSessions(count: number) {
  const organizationId = await tracker.create();
  const user = await createTestUser(organizationId);
  const sessions: string[] = [];
  for (let index = 0; index < count; index += 1) {
    sessions.push(
      await createTestSessionDetail({
        organizationId,
        userId: user.id,
        label: `component-${index}`,
      })
    );
  }
  const first = sessions[0];
  if (!first) {
    throw new Error("Fixture requires a session");
  }
  const session = await withDb((db) =>
    db.sessionDetail.findUniqueOrThrow({
      where: { artifactId: first },
      select: { computeTargetId: true },
    })
  );
  return { organizationId, sessions, computeTargetId: session.computeTargetId };
}
function inventory(
  fixture: Awaited<ReturnType<typeof seedSessions>>,
  componentKind: AgentComponentKind,
  componentKey: string,
  overrides: {
    contentHash?: string;
    packId?: string;
    uninstalledAt?: Date;
  } = {}
) {
  return withDb(
    async (db) =>
      (
        await db.agentComponent.create({
          data: {
            organizationId: fixture.organizationId,
            computeTargetId: fixture.computeTargetId,
            componentKind,
            componentKey,
            externalComponentId: uuidv7(),
            name: componentKey,
            ...overrides,
          },
          select: { id: true },
        })
      ).id
  );
}
function usages(
  rows: {
    agentSessionId: string;
    componentKind: AgentComponentKind;
    componentKey: string;
    agentComponentId: string | null;
    componentVersionHash?: string;
  }[]
) {
  return withDb((db) =>
    db.agentComponentSessionUsage.createMany({
      data: rows.map((row) => ({ ...row, invocationCount: 1 })),
    })
  );
}
