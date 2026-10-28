import {
  AgentComponentInvocationSyncAckState,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  EXTERNAL_SESSION_ID,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  SESSION_ID,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { agentComponentInvocationsService } from "./component-invocations";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
}));
vi.mock("@repo/database", () => ({
  Prisma: {
    sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
      strings: [...strings],
      values,
    }),
    join: (values: unknown[]) => values,
  },
  SourceAccessState: { accessible: "accessible" },
  SourceOccurrenceType: {
    local: "local",
    repository: "repository",
    pack: "pack",
  },
  withDb: Object.assign(vi.fn(), { tx: mocks.tx }),
}));
vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn() },
}));
vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

const installStatefulDb = () => installStatefulDbStore(mocks.tx);
const ingest = (part: ReturnType<typeof buildPart>) =>
  agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });

describe("invocation replay across machine migrations", () => {
  beforeEach(() => {
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });
  it("activates historical invocations replayed from a different machine", async () => {
    const fixture = installStatefulDb();
    installSessionVisibility(fixture, [
      {
        artifactId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    ]);

    const result = await ingest(buildPart({ allItems: [buildItem()] }));

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(fixture.generations[0]?.agentSessionId).toBe(SESSION_ID);
    expect(fixture.db.agentComponent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        }),
      })
    );
    expect(fixture.db.sessionDetail.update).toHaveBeenCalledWith({
      where: { artifactId: SESSION_ID },
      data: { componentInvocationCount: 1 },
      select: { artifactId: true },
    });
  });

  it.each([PREVIOUS_COMPUTE_TARGET_ID, COMPUTE_TARGET_ID])(
    "rejects a session belonging to another organization on %s",
    async (computeTargetId) => {
      const fixture = installStatefulDb();
      installSessionVisibility(fixture, [
        {
          artifactId: SESSION_ID,
          organizationId: OTHER_ORGANIZATION_ID,
          computeTargetId,
          externalSessionId: EXTERNAL_SESSION_ID,
        },
      ]);

      expect(await ingest(buildPart({ allItems: [buildItem()] }))).toEqual({
        ok: false,
        error: AgentComponentInvocationSyncRejectReason.SessionMissing,
      });
      expect(fixture.generations).toHaveLength(0);
      expect(fixture.db.sessionDetail.update).not.toHaveBeenCalled();
    }
  );

  it("rejects ambiguous historical session identities without changing either session", async () => {
    const fixture = installStatefulDb();
    installSessionVisibility(fixture, [
      {
        artifactId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
      {
        artifactId: "another-session",
        organizationId: ORGANIZATION_ID,
        computeTargetId: "another-machine",
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    ]);

    expect(await ingest(buildPart({ allItems: [buildItem()] }))).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.SessionMissing,
    });
    expect(fixture.generations).toHaveLength(0);
  });

  it("preserves the sending machine's session when the same ID exists historically", async () => {
    const fixture = installStatefulDb();
    installSessionVisibility(fixture, [
      {
        artifactId: "historical-session",
        organizationId: ORGANIZATION_ID,
        computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
      {
        artifactId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    ]);

    expect(await ingest(buildPart({ allItems: [buildItem()] }))).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(fixture.generations[0]?.agentSessionId).toBe(SESSION_ID);
  });

  it("keeps a generation on the parent it started on when the local parent appears mid-replay", async () => {
    // whitlockk, #8429: session sync can create the current target's own parent
    // AFTER part 0 staged on the historical one. Preferring the local parent
    // from then on starts a SECOND generation, and neither holds every part —
    // and Desktop drops an accepted part from its retry queue even for a staged
    // ACK, so the missing parts are never resent and the replay is stranded.
    const fixture = installStatefulDb();
    const historical: VisibleSession[] = [
      {
        artifactId: "historical-session",
        organizationId: ORGANIZATION_ID,
        computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    ];
    installSessionVisibility(fixture, historical);
    const items = [
      buildItem(),
      buildItem({ externalInvocationId: "invocation-2", sequence: 1 }),
    ];

    const first = await ingest(
      buildPart({ allItems: items, items: [items[0]], partCount: 2 })
    );
    expect(first).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    expect(fixture.generations).toHaveLength(1);
    expect(fixture.generations[0]?.agentSessionId).toBe("historical-session");

    // Session sync lands the sending machine's own parent between deliveries.
    installSessionVisibility(fixture, [
      ...historical,
      {
        artifactId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        computeTargetId: COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
      },
    ]);

    const second = await ingest(
      buildPart({
        allItems: items,
        items: [items[1]],
        partIndex: 1,
        partCount: 2,
      })
    );

    expect(second).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(fixture.generations).toHaveLength(1);
    expect(fixture.generations[0]?.agentSessionId).toBe("historical-session");
  });

  it("rejects a same-org session owned by another person", async () => {
    // tamsinb, #8429: the historical lookup was org-scoped, so any teammate's
    // desktop sending a part that carries YOUR externalSessionId replaced the
    // active generation on your session and resolved its components against
    // your machine's inventory. A replacement machine is always the same
    // person, so the probe requires the owning target's user to match the
    // sender's.
    const fixture = installStatefulDb();
    installSessionVisibility(fixture, [
      {
        artifactId: SESSION_ID,
        organizationId: ORGANIZATION_ID,
        computeTargetId: PREVIOUS_COMPUTE_TARGET_ID,
        externalSessionId: EXTERNAL_SESSION_ID,
        userId: OTHER_USER_ID,
      },
    ]);

    expect(await ingest(buildPart({ allItems: [buildItem()] }))).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.SessionMissing,
    });
    expect(fixture.generations).toHaveLength(0);
    expect(fixture.db.sessionDetail.update).not.toHaveBeenCalled();
  });
});

const PREVIOUS_COMPUTE_TARGET_ID = "previous-machine";
const OTHER_ORGANIZATION_ID = "other-organization";
/** The signed-in person whose machine is sending. */
const SENDER_USER_ID = "user-1";
/** A teammate in the SAME organization. */
const OTHER_USER_ID = "user-2";

type VisibleSession = {
  artifactId: string;
  organizationId: string;
  computeTargetId: string;
  externalSessionId: string;
  /** Owner of `computeTargetId`; defaults to the sending person. */
  userId?: string;
};

function installSessionVisibility(
  fixture: ReturnType<typeof installStatefulDb>,
  rows: VisibleSession[]
) {
  const db = fixture.db;
  type Where = {
    computeTargetId?: string;
    externalSessionId?: string | { in: string[] };
    artifact?: { organizationId?: string };
  };
  const ownerOf = (row: VisibleSession) => row.userId ?? SENDER_USER_ID;
  function visible(where: Where) {
    return rows.filter((row) => {
      if (
        where.computeTargetId !== undefined &&
        row.computeTargetId !== where.computeTargetId
      ) {
        return false;
      }
      if (
        where.artifact?.organizationId !== undefined &&
        row.organizationId !== where.artifact.organizationId
      ) {
        return false;
      }
      if (typeof where.externalSessionId === "string") {
        return row.externalSessionId === where.externalSessionId;
      }
      return (
        where.externalSessionId === undefined ||
        where.externalSessionId.in.includes(row.externalSessionId)
      );
    });
  }
  db.sessionDetail.findFirst.mockImplementation(({ where }: { where: Where }) =>
    Promise.resolve(visible(where)[0] ?? null)
  );
  // Both raw probes take ONE candidate per call and are scoped to the sending
  // target's own user. This stand-in models every filter it is handed, so a
  // lookup that dropped one fails here rather than reading as "no match".
  const senderUserIdFor = (senderTargetId: string) => {
    const senderRow = rows.find(
      (row) => row.computeTargetId === senderTargetId
    );
    return senderRow ? ownerOf(senderRow) : SENDER_USER_ID;
  };
  // The user filter is applied only when the STATEMENT asks for it, so dropping
  // `owner.user_id = sender.user_id` from the production SQL fails the
  // cross-user cases here instead of leaving this stand-in answering the same
  // rows either way.
  const inScope = (
    sql: string,
    row: VisibleSession,
    candidate: string,
    organizationId: string,
    senderUserId: string
  ) =>
    row.externalSessionId === candidate &&
    row.organizationId === organizationId &&
    (!sql.includes("owner.user_id = sender.user_id") ||
      ownerOf(row) === senderUserId);

  db.$queryRaw.mockImplementation(
    (query: { strings: string[]; values: unknown[] }) => {
      const sql = query.strings.join("");
      // "Where did this generation start?" — no cardinality guard, because it
      // follows an existing row rather than choosing a parent.
      if (sql.includes("gen.external_generation_id =")) {
        const [
          senderTargetId,
          candidate,
          organizationId,
          externalGenerationId,
        ] = query.values as string[];
        const senderUserId = senderUserIdFor(senderTargetId);
        const started = rows
          .filter((row) =>
            inScope(sql, row, candidate, organizationId, senderUserId)
          )
          .filter((row) =>
            fixture.generations.some(
              (generation) =>
                generation.agentSessionId === row.artifactId &&
                generation.externalGenerationId === externalGenerationId
            )
          );
        return Promise.resolve(started.slice(0, 1));
      }
      if (!sql.includes("HAVING COUNT(*) = 1")) {
        return Promise.resolve([]);
      }
      const [senderTargetId, candidate, organizationId] =
        query.values as string[];
      const senderUserId = senderUserIdFor(senderTargetId);
      const matches = rows.filter((row) =>
        inScope(sql, row, candidate, organizationId, senderUserId)
      );
      return Promise.resolve(matches.length === 1 ? matches : []);
    }
  );
}
