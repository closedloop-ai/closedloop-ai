import { AgentComponentKind } from "@repo/api/src/types/agent-component";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { describe, expect, it } from "vitest";
import {
  queryAgentComponentFrequencyLocal,
  resolveLocalComponentSessionIds,
} from "../src/main/dashboard/component-session-scope.js";
import { createSqliteSessionSyncSource } from "../src/main/database/sync-source.js";
import {
  insertComponent,
  insertUsage,
} from "./agent-components-test-fixtures.js";
import { openTestPrisma } from "./prisma-test-utils.js";
import { seedSession } from "./session-sweep-fixtures.js";

describe("local canonical component session scope", () => {
  it("keeps all family versions through the real sync source without hydrating session histories", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      await insertComponent(prisma, {
        id: "skill",
        externalId: "skill",
        key: "café",
        kind: AgentComponentKind.Skill,
        contentHash: "a".repeat(64),
      });
      await insertUsage(prisma, {
        sessionId: "old",
        kind: AgentComponentKind.Skill,
        key: "CAFÉ",
        invocations: 2,
        versionHash: "old",
      });
      await insertUsage(prisma, {
        sessionId: "new",
        kind: AgentComponentKind.Skill,
        key: " café ",
        invocations: 3,
        versionHash: null,
      });
      await insertUsage(prisma, {
        sessionId: "other",
        kind: AgentComponentKind.Skill,
        key: "other",
        invocations: 9,
      });
      const source = createSqliteSessionSyncSource(prisma);
      expect(
        [
          ...((await source.resolveComponentSessionIds?.(
            `${AgentComponentKind.Skill}::${"a".repeat(64)}`
          )) ?? []),
        ].sort()
      ).toEqual(["new", "old"]);
      expect(await resolveLocalComponentSessionIds(prisma, "invalid")).toEqual(
        []
      );
    } finally {
      await close();
    }
  });
  it("uses the plugin's child identity and authoritative FK instead of direct plugin usage", async () => {
    const { prisma, close } = await openTestPrisma();
    try {
      await insertComponent(prisma, {
        id: "plugin",
        externalId: "plugin",
        key: "pack",
        kind: AgentComponentKind.Plugin,
        packId: "pack",
      });
      await insertComponent(prisma, {
        id: "live",
        externalId: "live",
        key: "child",
        kind: AgentComponentKind.Skill,
        packId: "pack",
      });
      await insertComponent(prisma, {
        id: "dead",
        externalId: "dead",
        key: "child",
        kind: AgentComponentKind.Skill,
        packId: "pack",
        uninstalledAt: "2026-10-18T00:00:00Z",
      });
      for (const [sessionId, agentComponentId] of [
        ["linked", "live"],
        ["orphan", null],
        ["dead", "dead"],
      ] as const) {
        await insertUsage(prisma, {
          sessionId,
          agentComponentId,
          kind: AgentComponentKind.Skill,
          key: "child",
          invocations: 2,
        });
      }
      expect(
        [
          ...(await resolveLocalComponentSessionIds(
            prisma,
            `${AgentComponentKind.Plugin}::pack`
          )),
        ].sort()
      ).toEqual(["linked", "orphan"]);
    } finally {
      await close();
    }
  });
  it("groups canonical invocations on UTC session-start days with measured empty days", async () => {
    const { db, prisma, close } = await openTestPrisma();
    try {
      await seedSession(
        db,
        "one",
        SESSION_STATUS.INACTIVE,
        "2026-10-19T12:00:00Z",
        undefined,
        "2026-10-18T23:30:00-02:00"
      );
      await seedSession(
        db,
        "two",
        SESSION_STATUS.INACTIVE,
        "2026-10-19T12:00:00Z",
        undefined,
        "2026-10-18T00:00:00Z"
      );
      await insertUsage(prisma, {
        sessionId: "one",
        kind: AgentComponentKind.Skill,
        key: "deploy",
        invocations: 3,
      });
      await insertUsage(prisma, {
        sessionId: "two",
        kind: AgentComponentKind.Skill,
        key: "deploy",
        invocations: 5,
      });
      expect(
        await queryAgentComponentFrequencyLocal(
          prisma,
          `${AgentComponentKind.Skill}::deploy`,
          3,
          new Date("2026-10-19T12:00:00Z")
        )
      ).toEqual({
        windowDays: 3,
        points: [
          { day: "2026-10-17", invocations: 0 },
          { day: "2026-10-18", invocations: 5 },
          { day: "2026-10-19", invocations: 3 },
        ],
      });
    } finally {
      await close();
    }
  });
});
