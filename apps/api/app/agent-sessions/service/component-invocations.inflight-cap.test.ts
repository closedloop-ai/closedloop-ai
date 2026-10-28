import {
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  const withDb = Object.assign(vi.fn(), { tx: mocks.tx });
  return {
    Prisma: { sql },
    SourceAccessState: { accessible: "accessible" },
    SourceOccurrenceType: {
      local: "local",
      repository: "repository",
      pack: "pack",
    },
    withDb,
  };
});

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError },
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  type GenerationRow,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  SESSION_ID,
  SOURCE_UPDATED_AT,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import { agentComponentInvocationsService } from "./component-invocations";

const installStatefulDb: (
  input?: Parameters<typeof installStatefulDbStore>[1]
) => ReturnType<typeof installStatefulDbStore> = (input) =>
  installStatefulDbStore(mocks.tx, input);

function ingest(part: AgentComponentInvocationSyncPart) {
  return agentComponentInvocationsService.ingestPart({
    organizationId: ORGANIZATION_ID,
    computeTargetId: COMPUTE_TARGET_ID,
    part,
  });
}

/**
 * ISS-6883. The in-flight cap is a CONCURRENCY bound on how many generations a
 * session may have open at once. It therefore has to be charged when a
 * generation is CREATED, never when a later part of an already-admitted one
 * arrives — a part that cannot land leaves its generation permanently
 * incomplete, and Desktop charges `validation_failed` as a permanent rejection
 * (`invocation-sync-rejection-policy.ts`), so the part dead-letters into a lane
 * with no dead-letter recovery.
 *
 * A genuine cap is therefore answered with `rate_limited`, the lane-wide reason
 * Desktop already classifies as transient: capacity is a property of the
 * session, not of the part being charged, so the part must defer and retry
 * rather than spend a permanent budget it cannot earn back.
 *
 * The boundary that actually distinguishes the fix is the FULL cap: N-1 other
 * incomplete generations plus the incoming one. A fixture with fewer than
 * `AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS` generations
 * present passes with or without the fix, so every case below is anchored to
 * that constant rather than to a hand-written 4 or 5.
 */
const OTHER_INFLIGHT_GENERATIONS =
  AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS - 1;

describe("ingestPart in-flight generation cap", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });

  it("admits a later part of a generation that was already admitted at the cap", async () => {
    const { db, generations } = installStatefulDb({
      generations: buildOtherInflightGenerations(),
    });
    const [firstPart, secondPart] = buildTwoPartGeneration();

    const admitted = await ingest(firstPart);
    const progressed = await ingest(secondPart);

    expect(admitted).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    expect(progressed).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    const persisted = generations.find(
      (row) => row.externalGenerationId === secondPart.externalGenerationId
    );
    expect(persisted?.completedAt).not.toBeNull();
    expect(persisted?.activeAt).not.toBeNull();
    expect(db.agentComponentInvocationPart.create).toHaveBeenCalledTimes(2);
  });

  it("still rejects a genuinely new generation once the cap is full", async () => {
    const { generations } = installStatefulDb({
      generations: buildOtherInflightGenerations(),
    });
    const [firstPart] = buildTwoPartGeneration();
    await ingest(firstPart);

    const sixth = await ingest(
      buildPart({
        allItems: [
          buildItem({ externalInvocationId: "sixth-generation-invocation" }),
        ],
      })
    );

    expect(sixth).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.RateLimited,
    });
    expect(generations).toHaveLength(
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS
    );
    expect(generations.some((row) => row.expectedPartCount === 1)).toBe(false);
  });

  it("admits a new generation while the session is one below the cap", async () => {
    const { generations } = installStatefulDb({
      generations: buildOtherInflightGenerations(),
    });

    const result = await ingest(
      buildPart({
        allItems: [
          buildItem({ externalInvocationId: "fifth-generation-invocation" }),
        ],
      })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(generations).toHaveLength(
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS
    );
  });

  it("treats the same generation id at a newer freshness triple as a different generation", async () => {
    const newerSameId = buildGenerationFixture("multipart-generation");
    newerSameId.sourceSequence = 9;
    const { generations } = installStatefulDb({
      generations: [...buildOtherInflightGenerations(), newerSameId],
    });
    const olderPart = buildPart({
      allItems: [buildItem()],
      sourceSequence: 1,
    });
    newerSameId.externalGenerationId = olderPart.externalGenerationId;

    const result = await ingest(olderPart);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.RateLimited,
    });
    expect(generations).toHaveLength(
      AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS
    );
    expect(
      generations.filter(
        (row) => row.externalGenerationId === olderPart.externalGenerationId
      )
    ).toEqual([newerSameId]);
  });

  it("counts only this session's in-flight generations against the cap", async () => {
    const { generations } = installStatefulDb({
      generations: Array.from(
        { length: AGENT_COMPONENT_INVOCATION_SYNC_MAX_INFLIGHT_GENERATIONS },
        (_unused, index) => {
          const row = buildGenerationFixture(`other-session-${index}`);
          row.agentSessionId = OTHER_SESSION_ID;
          return row;
        }
      ),
    });

    const result = await ingest(
      buildPart({
        allItems: [
          buildItem({ externalInvocationId: "this-session-invocation" }),
        ],
      })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(
      generations.filter((row) => row.agentSessionId === SESSION_ID)
    ).toHaveLength(1);
  });
});

/** A session other than the one `ingest` resolves to, for cap-scoping coverage. */
const OTHER_SESSION_ID = "44444444-4444-4444-8444-444444444444";

/** `MAX - 1` unrelated incomplete generations: the session at one below the cap. */
function buildOtherInflightGenerations(): GenerationRow[] {
  return Array.from({ length: OTHER_INFLIGHT_GENERATIONS }, (_unused, index) =>
    buildGenerationFixture(`other-inflight-${index}`)
  );
}

/** Two parts of ONE generation, so part 1 is progress on an admitted generation. */
function buildTwoPartGeneration(): [
  AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncPart,
] {
  const first = buildItem({
    externalInvocationId: "multipart-invocation-1",
    sequence: 0,
  });
  const second = buildItem({
    externalInvocationId: "multipart-invocation-2",
    sequence: 1,
  });
  const allItems = [first, second];
  return [
    buildPart({ allItems, items: [first], partIndex: 0, partCount: 2 }),
    buildPart({ allItems, items: [second], partIndex: 1, partCount: 2 }),
  ];
}

function buildGenerationFixture(externalGenerationId: string): GenerationRow {
  return {
    id: externalGenerationId,
    agentSessionId: SESSION_ID,
    externalGenerationId,
    sourceUpdatedAt: new Date(SOURCE_UPDATED_AT),
    dataRevision: 35,
    sourceSequence: 1,
    expectedPartCount: 2,
    activeAt: null,
    completedAt: null,
    updatedAt: new Date(),
  };
}
