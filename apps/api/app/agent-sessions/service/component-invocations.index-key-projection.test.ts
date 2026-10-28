import {
  AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
  AgentComponentInvocationSyncAckState,
  type AgentComponentInvocationSyncPart,
  AgentComponentInvocationSyncRejectReason,
  agentComponentInvocationGenerationHashPreimage,
  agentComponentInvocationSyncPartHashPreimage,
} from "@repo/api/src/types/agent-component-invocation";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  tx: vi.fn(),
  ensureDefinitionVersion: vi.fn(),
  recordDefinitionSourceOccurrence: vi.fn(),
  logError: vi.fn(),
  logWarn: vi.fn(),
  emitTelemetryMetric: vi.fn(),
}));

vi.mock("@repo/database", () => {
  const sql = (strings: TemplateStringsArray, ...values: unknown[]) => ({
    strings: [...strings],
    values,
  });
  const withDb = Object.assign(vi.fn(), { tx: mocks.tx });
  return {
    Prisma: { sql, join: (values: unknown[]) => values },
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
  log: { error: mocks.logError, warn: mocks.logWarn },
}));

vi.mock("@repo/observability/telemetry/metrics", () => ({
  emitTelemetryMetric: mocks.emitTelemetryMetric,
}));

vi.mock("@/app/definition-registry/service", () => ({
  ensureDefinitionVersion: mocks.ensureDefinitionVersion,
  recordDefinitionSourceOccurrence: mocks.recordDefinitionSourceOccurrence,
}));

import {
  buildItem,
  buildPart,
  COMPUTE_TARGET_ID,
  installStatefulDb as installStatefulDbStore,
  ORGANIZATION_ID,
  sha256,
} from "@/__tests__/support/agent-sessions/service/component-invocations.test-db";
import {
  hasProjectedIndexKeyShape,
  INDEX_KEY_MAX_BYTES,
  INDEX_KEY_PROJECTED_METRIC,
  projectedIndexKeyHead,
  projectIndexKey,
} from "@/lib/index-key-projection";
import { INDEX_KEY_PROJECTION_ORG_BUDGET } from "@/lib/index-key-projection-telemetry";
import { agentComponentInvocationsService } from "./component-invocations";
import {
  INVOCATION_INDEX_KEY_PROJECTED_EVENT,
  INVOCATION_INDEX_KEY_PROJECTED_MESSAGE,
  invocationIndexKeyProjectionGate,
} from "./invocation-index-key-telemetry";
import { SessionSyncMetric } from "./session-sync-metrics";

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

const TEXT_ENCODER = new TextEncoder();
const OVER_BUDGET_ASCII = "k".repeat(3000);
const OVER_BUDGET_MULTIBYTE = "日".repeat(1000);
// Past the 512-byte projection budget, inside the 2704-byte index limit: the
// shape a row written before ISS-8736 could hold verbatim.
const LEGACY_RAW_ID = "legacy-".padEnd(600, "x");
const RESERVED_SHORT_KEY = "Read~idxsha256:not-a-digest";
const SKIPPED_HASH_CHECK_MESSAGE =
  "Skipped generation hash check for rewritten invocation rows";

/**
 * ISS-8736: `externalInvocationId`, `componentKey` and `branchName` each land
 * on a btree index key, which Postgres caps at 2704 bytes per tuple. An
 * over-budget value is stored PROJECTED (ISS-8069) rather than making the
 * whole part throw, and the generation still activates: its hash was computed
 * over bytes the projected row no longer holds, so that one check is skipped
 * for it while the per-part hash stays verified on the raw wire.
 */
describe("agentComponentInvocationsService.ingestPart index-key projection", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // ISS-8736: the projection report is throttled per (org, compute target).
    // Without this reset the FIRST case here would spend the window and every
    // later one would assert against a suppressed emission.
    invocationIndexKeyProjectionGate.clear();
    mocks.ensureDefinitionVersion.mockResolvedValue("definition-version-1");
    mocks.recordDefinitionSourceOccurrence.mockResolvedValue(
      "source-occurrence-1"
    );
  });

  it.each([
    ["externalInvocationId", OVER_BUDGET_ASCII],
    ["componentKey", OVER_BUDGET_ASCII],
    ["branchName", OVER_BUDGET_ASCII],
    ["componentKey", OVER_BUDGET_MULTIBYTE],
  ] as const)(
    "stores an over-budget %s projected, lands the part, and reports the projection",
    async (field, value) => {
      const { invocations } = installStatefulDb();
      const item = buildItem({ [field]: value });

      const result = await ingest(buildPart({ allItems: [item] }));

      expect(result).toEqual({
        ok: true,
        value: { state: AgentComponentInvocationSyncAckState.Activated },
      });
      expect(invocations).toHaveLength(1);
      const stored = String(invocations[0]?.[field]);
      expect(stored).not.toBe(value);
      expect(hasProjectedIndexKeyShape(stored)).toBe(true);
      expect(TEXT_ENCODER.encode(stored).byteLength).toBeLessThanOrEqual(
        INDEX_KEY_MAX_BYTES
      );
      expect(projectionEmissions()).toEqual([
        {
          metric: INDEX_KEY_PROJECTED_METRIC,
          organizationId: ORGANIZATION_ID,
          computeTargetId: COMPUTE_TARGET_ID,
          count: 1,
        },
      ]);
    }
  );

  it("bounds the multibyte key by its byte length, not its character count", async () => {
    const { invocations } = installStatefulDb();
    expect(OVER_BUDGET_MULTIBYTE).toHaveLength(1000);
    expect(TEXT_ENCODER.encode(OVER_BUDGET_MULTIBYTE).byteLength).toBe(3000);

    await ingest(
      buildPart({
        allItems: [buildItem({ componentKey: OVER_BUDGET_MULTIBYTE })],
      })
    );

    expect(
      hasProjectedIndexKeyShape(String(invocations[0]?.componentKey))
    ).toBe(true);
  });

  it("stores an ordinary key verbatim, checks the generation hash, and emits nothing", async () => {
    const { invocations } = installStatefulDb();
    const item = buildItem({
      externalInvocationId: "invocation-1",
      componentKey: "code-review",
      branchName: "feat/iss-8736",
    });

    const result = await ingest(buildPart({ allItems: [item] }));

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(invocations[0]).toMatchObject({
      externalInvocationId: "invocation-1",
      componentKey: "code-review",
      branchName: "feat/iss-8736",
    });
    expect(projectionEmissions()).toEqual([]);
    expect(mocks.logWarn).not.toHaveBeenCalled();
  });

  it.each([
    ["unprojected", buildItem()],
    ["over-budget", buildItem({ componentKey: OVER_BUDGET_ASCII })],
    ["reserved-namespace", buildItem({ componentKey: RESERVED_SHORT_KEY })],
  ])(
    "still rejects a one-part generation with %s keys that does not hash to its id",
    async (_label, item) => {
      installStatefulDb();
      const withoutHash = {
        ...buildPart({ allItems: [item] }),
        externalGenerationId: "b".repeat(64),
      };
      const mismatched = {
        ...withoutHash,
        partHash: sha256(
          agentComponentInvocationSyncPartHashPreimage(withoutHash)
        ),
      };

      const result = await ingest(mismatched);

      expect(result).toEqual({
        ok: false,
        error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
      });
      expect(mocks.logWarn).not.toHaveBeenCalledWith(
        SKIPPED_HASH_CHECK_MESSAGE,
        expect.anything()
      );
    }
  );

  it("stores a short reserved-namespace key projected and still lands it", async () => {
    const { invocations } = installStatefulDb();

    const result = await ingest(
      buildPart({ allItems: [buildItem({ componentKey: RESERVED_SHORT_KEY })] })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(invocations[0]?.componentKey).not.toBe(RESERVED_SHORT_KEY);
    expect(
      hasProjectedIndexKeyShape(String(invocations[0]?.componentKey))
    ).toBe(true);
  });

  it("rejects an id already staged raw by a build before ISS-8736", async () => {
    const { invocations, parts } = installStatefulDb();
    const first = buildItem({
      externalInvocationId: LEGACY_RAW_ID,
      sequence: 0,
    });
    const duplicate = buildItem({
      externalInvocationId: LEGACY_RAW_ID,
      sequence: 1,
      rawName: "second occurrence",
    });
    const part0 = buildPart({
      allItems: [first, duplicate],
      items: [first],
      partCount: 2,
    });
    const part1 = buildPart({
      allItems: [first, duplicate],
      items: [duplicate],
      partIndex: 1,
      partCount: 2,
    });
    await ingest(part0);
    // Restage part0 as a build before ISS-8736 left it: as an invocation row
    // holding the raw id (and, predating ISS-12781, nothing on the ledger row).
    expect(parts).toHaveLength(1);
    const [legacyPart] = parts;
    legacyPart.stagedItems = null;
    legacyPart.stagedInvocationIds = null;
    invocations.push({
      id: "legacy-row",
      generationId: legacyPart.generationId,
      partId: legacyPart.id,
      externalInvocationId: LEGACY_RAW_ID,
      sequence: 0,
    });

    const result = await ingest(part1);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
    expect(parts).toHaveLength(1);
  });

  it("de-dupes a retry of the same over-long externalInvocationId", async () => {
    const { invocations } = installStatefulDb();
    const part = buildPart({
      allItems: [buildItem({ externalInvocationId: OVER_BUDGET_ASCII })],
    });

    const first = await ingest(part);
    const retried = await ingest(part);

    expect(first).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(retried).toEqual(first);
    expect(invocations).toHaveLength(1);
  });

  it("rejects an over-long externalInvocationId reused by a different part", async () => {
    const { parts } = installStatefulDb();
    const first = buildItem({
      externalInvocationId: OVER_BUDGET_ASCII,
      sequence: 0,
    });
    const duplicate = buildItem({
      externalInvocationId: OVER_BUDGET_ASCII,
      sequence: 1,
      rawName: "second occurrence",
    });
    const part0 = buildPart({
      allItems: [first, duplicate],
      items: [first],
      partCount: 2,
    });
    const part1 = buildPart({
      allItems: [first, duplicate],
      items: [duplicate],
      partIndex: 1,
      partCount: 2,
    });

    await ingest(part0);
    const result = await ingest(part1);

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.GenerationConflict,
    });
    expect(parts).toHaveLength(1);
  });

  it("activates a multi-part generation whose earlier part carried a projected key, skipping the hash it cannot recompute", async () => {
    const { invocations, generations } = installStatefulDb();
    const first = buildItem({
      externalInvocationId: "invocation-1",
      componentKey: OVER_BUDGET_ASCII,
      sequence: 0,
    });
    const second = buildItem({
      externalInvocationId: "invocation-2",
      sequence: 1,
    });
    const part0 = buildPart({
      allItems: [first, second],
      items: [first],
      partCount: 2,
    });
    const part1 = buildPart({
      allItems: [first, second],
      items: [second],
      partIndex: 1,
      partCount: 2,
    });

    const staged = await ingest(part0);
    const activated = await ingest(part1);

    expect(staged).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Staged },
    });
    expect(activated).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    expect(invocations).toHaveLength(2);
    expect(generations[0]?.activeAt).not.toBeNull();
    // ISS-4965 (tamsinb review, #8391): the skip is a monitored family member.
    expect(mocks.logWarn).toHaveBeenCalledWith(
      SKIPPED_HASH_CHECK_MESSAGE,
      expect.objectContaining({
        metric: SessionSyncMetric.InvocationGenerationHashUnverified,
        externalGenerationId: part0.externalGenerationId,
      })
    );
    // Only part0 held a projected key, so exactly one emission of one.
    expect(projectionEmissions()).toEqual([
      expect.objectContaining({ count: 1 }),
    ]);
  });

  /**
   * ISS-8736 review (whitlockk): projecting `componentKey` also changes the LOOKUP
   * identity. An `agent_components` row written before ISS-8069 can still hold
   * the raw 513-2704-byte value, which the projected `IN` list cannot match, so
   * the invocation would resolve to `none` forever.
   */
  it("resolves a projected invocation against a component row still stored raw", async () => {
    const rawComponentKey = "legacy-component-".padEnd(600, "y");
    const projectedComponentKey = projectIndexKey(rawComponentKey).value;
    const { db } = installStatefulDb();
    // The fake ignores `where`, so discriminate on query SHAPE: the exact
    // IN-list lookup finds nothing (the stored row is raw), and only the
    // head-prefix probe returns it.
    db.agentComponent.findMany.mockImplementation(
      (args: { where?: { OR?: unknown[] } }) =>
        Promise.resolve(
          args?.where?.OR
            ? [
                {
                  id: "legacy-component-id",
                  componentKind: "tool",
                  componentKey: rawComponentKey,
                },
              ]
            : []
        )
    );

    const result = await ingest(
      buildPart({
        allItems: [buildItem({ componentKey: rawComponentKey, kind: "tool" })],
      })
    );

    expect(result).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    const probe = db.agentComponent.findMany.mock.calls
      .map((call) => call[0] as { where?: { OR?: unknown[] } })
      .find((args) => args?.where?.OR);
    // Probed by the RETAINED HEAD, never by the whole projected key.
    expect(probe?.where?.OR).toEqual([
      {
        componentKey: {
          startsWith: projectedIndexKeyHead(projectedComponentKey),
        },
      },
    ]);
    // The probe is a FALLBACK: the exact IN-list lookup runs first and only its
    // miss reaches the prefix query. (This fake cannot observe the attribution
    // write itself — `component-invocations-ingest-realdb.test.ts` covers that
    // against real Postgres.)
    const shapes = db.agentComponent.findMany.mock.calls.map((call) =>
      (call[0] as { where?: { OR?: unknown[] } })?.where?.OR ? "probe" : "exact"
    );
    expect(shapes).toEqual(["exact", "probe"]);
  });

  /**
   * ISS-8736 review (chatgpt-codex-connector): the part IS the request and an
   * authenticated desktop drives the rate, so an unbounded per-part emission is
   * the amplification vector `apps/api/AGENTS.md` ("Emission and Abuse
   * Control") names. These pin the bound, not the projection.
   */
  describe("emission bound", () => {
    it("emits once per (org, compute target) window and suppresses the replay", async () => {
      installStatefulDb();
      const item = buildItem({ componentKey: OVER_BUDGET_ASCII });

      await ingest(buildPart({ allItems: [item] }));
      expect(projectionEmissions()).toHaveLength(1);
      expect(projectionWarns()).toHaveLength(1);

      installStatefulDb();
      await ingest(buildPart({ allItems: [item] }));

      // The replay projected again, but reported nothing new: same key, same
      // window. Suppression is what the rule asks for; the count is not lost,
      // it is carried on the next window's rollup.
      expect(projectionEmissions()).toHaveLength(1);
      expect(projectionWarns()).toHaveLength(1);
    });

    it("never suppresses a first occurrence from a different compute target's org", async () => {
      installStatefulDb();
      const item = buildItem({ componentKey: OVER_BUDGET_ASCII });
      await ingest(buildPart({ allItems: [item] }));
      expect(projectionEmissions()).toHaveLength(1);

      installStatefulDb();
      await agentComponentInvocationsService.ingestPart({
        organizationId: `${ORGANIZATION_ID}-other`,
        computeTargetId: `${COMPUTE_TARGET_ID}-other`,
        part: buildPart({ allItems: [item] }),
      });

      // A genuinely new tenant is never the occurrence the bound eats.
      expect(projectionEmissions()).toHaveLength(2);
    });

    it("caps one org at its per-window budget across the targets it owns", async () => {
      const item = buildItem({ componentKey: OVER_BUDGET_ASCII });
      const attempts = INDEX_KEY_PROJECTION_ORG_BUDGET + 3;

      for (let index = 0; index < attempts; index += 1) {
        installStatefulDb();
        // A fresh compute target each pass: this is the resource churn that
        // would evict the finer key and make every request a first occurrence
        // if the coarse org budget did not exist.
        await agentComponentInvocationsService.ingestPart({
          organizationId: ORGANIZATION_ID,
          computeTargetId: `${COMPUTE_TARGET_ID}-${index}`,
          part: buildPart({ allItems: [item] }),
        });
      }

      expect(projectionEmissions()).toHaveLength(
        INDEX_KEY_PROJECTION_ORG_BUDGET
      );
    });

    it("stamps the monitored event facet on the first occurrence", async () => {
      installStatefulDb();
      await ingest(
        buildPart({
          allItems: [buildItem({ componentKey: OVER_BUDGET_ASCII })],
        })
      );

      // The metric alone has no Datadog generator or monitor; this facet is
      // what an operator can key an alert on.
      expect(mocks.logWarn).toHaveBeenCalledWith(
        INVOCATION_INDEX_KEY_PROJECTED_MESSAGE,
        expect.objectContaining({
          event: INVOCATION_INDEX_KEY_PROJECTED_EVENT,
          organizationId: ORGANIZATION_ID,
          computeTargetId: COMPUTE_TARGET_ID,
          projectedCount: 1,
        })
      );
    });

    it("flushes the suppressed total as an aggregated rollup when the window rolls over", async () => {
      const item = buildItem({ componentKey: OVER_BUDGET_ASCII });
      const nowSpy = vi.spyOn(Date, "now");
      try {
        nowSpy.mockReturnValue(1000);
        installStatefulDb();
        await ingest(buildPart({ allItems: [item] }));
        installStatefulDb();
        await ingest(buildPart({ allItems: [item] }));

        // Past both windows, so the next occurrence rolls them over.
        nowSpy.mockReturnValue(1000 + 10 * 60_000);
        installStatefulDb();
        await ingest(buildPart({ allItems: [item] }));
      } finally {
        nowSpy.mockRestore();
      }

      // `sum(occurrences)` still tracks every projected part: the suppressed
      // one is carried by the rollup, not dropped.
      const rollups = projectionWarns().filter(
        (call) => call.aggregated === true
      );
      expect(rollups).toEqual([
        expect.objectContaining({
          event: INVOCATION_INDEX_KEY_PROJECTED_EVENT,
          organizationId: ORGANIZATION_ID,
          computeTargetId: COMPUTE_TARGET_ID,
          occurrences: 1,
          flushedBy: "window",
        }),
      ]);
      const total = projectionWarns().reduce(
        (sum, call) => sum + Number(call.occurrences ?? 0),
        0
      );
      expect(total).toBe(3);
    });
  });
});

function projectionWarns(): Record<string, unknown>[] {
  return mocks.logWarn.mock.calls
    .filter(([message]) => message === INVOCATION_INDEX_KEY_PROJECTED_MESSAGE)
    .map(([, payload]) => payload as Record<string, unknown>);
}

function projectionEmissions(): unknown[] {
  return mocks.emitTelemetryMetric.mock.calls
    .map(([arg]) => arg)
    .filter((arg) => arg?.metric === INDEX_KEY_PROJECTED_METRIC);
}

/**
 * ISS-8200: the invocation ingest resolving its parent session.
 *
 * The HIGHEST-CONSEQUENCE row of that ticket. `part.externalSessionId` is the
 * raw wire id, but the session ingest stores the column projected, so for every
 * re-keyed session the lookup missed and `ingestPart` answered
 * `SessionMissing` — a terminal reject, so the desktop dead-lettered the whole
 * invocation generation rather than retrying it.
 */
describe("invocation session identity (ISS-8200)", () => {
  const LEGACY_RAW_SESSION_ID = "s".repeat(INDEX_KEY_MAX_BYTES + 1);

  /**
   * A part for an over-budget session id. `buildPart` hashes its generation id
   * over the fixture's OWN session constant, so a custom id has to rebuild both
   * hashes or the service rejects on the generation hash before it ever reaches
   * the session lookup this case is about.
   */
  function partForSession(externalSessionId: string) {
    const items = [buildItem()];
    const withoutHash = {
      protocolVersion: AGENT_COMPONENT_INVOCATION_SYNC_PROTOCOL_VERSION,
      externalSessionId,
      externalGenerationId: sha256(
        agentComponentInvocationGenerationHashPreimage({
          externalSessionId,
          items,
        })
      ),
      sourceUpdatedAt: "2026-07-22T12:00:00.000Z",
      dataRevision: 35,
      sourceSequence: 1,
      partIndex: 0,
      partCount: 1,
      items,
    };
    return {
      ...withoutHash,
      partHash: sha256(
        agentComponentInvocationSyncPartHashPreimage(withoutHash)
      ),
    } as AgentComponentInvocationSyncPart;
  }

  /** Only the session lookup is re-pointed; the rest of the fixture stands. */
  function installSessionStoredUnder(storedKey: string) {
    const fixture = installStatefulDb();
    fixture.db.sessionDetail.findFirst.mockImplementation((args: never) => {
      const asked = (args as { where: { externalSessionId: string } }).where
        .externalSessionId;
      return Promise.resolve(
        asked === storedKey
          ? {
              artifactId: "session-artifact-1",
              computeTargetId: COMPUTE_TARGET_ID,
            }
          : null
      );
    });
    return fixture;
  }

  /**
   * The historical probe takes ONE candidate per call, so it is keyed on the
   * candidate it was handed rather than on a union list.
   */
  function installHistoricalSessionsUnder(
    fixture: ReturnType<typeof installStatefulDb>,
    storedKeys: string[]
  ) {
    const asked: string[] = [];
    fixture.db.$queryRaw.mockImplementation((query) => {
      if (!query.strings.join("").includes("HAVING COUNT(*) = 1")) {
        return Promise.resolve([]);
      }
      const candidate = query.values[1] as string;
      const organizationId = query.values[2] as string;
      asked.push(candidate);
      return Promise.resolve(
        storedKeys.includes(candidate) && organizationId === ORGANIZATION_ID
          ? [
              {
                artifactId: `session-artifact-${storedKeys.indexOf(candidate)}`,
                computeTargetId: "previous-machine",
              },
            ]
          : []
      );
    });
    return asked;
  }

  it.each([
    LEGACY_RAW_SESSION_ID,
    projectIndexKey(LEGACY_RAW_SESSION_ID).value,
  ])("replays a migrated session stored under %s", async (storedKey) => {
    const fixture = installStatefulDb({ sessionExists: false });
    installHistoricalSessionsUnder(fixture, [storedKey]);
    expect(await ingest(partForSession(LEGACY_RAW_SESSION_ID))).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
  });

  /**
   * REPLACES "rejects a migrated identity with both raw and projected
   * historical matches" (tamsinb, #8429). That expectation is obsoleted by
   * this diff, not weakened: a raw row and a projected row for ONE id are the
   * SAME session, and the module header above states that the projected key
   * wins when both exist. The old union-`IN` probe counted the pair as two
   * matches and failed its own `COUNT(*) = 1` guard, so a session that ingests
   * fine on its original machine could NEVER ingest from the replacement one —
   * it dead-lettered forever. The ordered walk resolves the pair the same way
   * the sending-machine lookup does.
   */
  it("resolves a raw and projected historical pair to the projected row", async () => {
    const fixture = installStatefulDb({ sessionExists: false });
    const projected = projectIndexKey(LEGACY_RAW_SESSION_ID).value;
    const asked = installHistoricalSessionsUnder(fixture, [
      projected,
      LEGACY_RAW_SESSION_ID,
    ]);

    expect(await ingest(partForSession(LEGACY_RAW_SESSION_ID))).toEqual({
      ok: true,
      value: { state: AgentComponentInvocationSyncAckState.Activated },
    });
    // Precedence, not merely "one of them": the projected candidate is probed
    // first and the raw one is never reached.
    expect(asked).toEqual([projected]);
    expect(fixture.generations[0]?.agentSessionId).toBe("session-artifact-0");
  });

  it("ingests a part for a session stored under its PROJECTED key", async () => {
    // The post-ISS-8069 session: the wire id is raw, the row is projected.
    const projected = projectIndexKey(LEGACY_RAW_SESSION_ID).value;
    installSessionStoredUnder(projected);

    const result = await ingest(partForSession(LEGACY_RAW_SESSION_ID));

    // Before this change every one of these answered SessionMissing.
    expect(result.ok).toBe(true);
  });

  it("ingests a part for a session still stored under its legacy RAW key", async () => {
    installSessionStoredUnder(LEGACY_RAW_SESSION_ID);

    const result = await ingest(partForSession(LEGACY_RAW_SESSION_ID));

    expect(result.ok).toBe(true);
  });

  it("still rejects SessionMissing when no candidate holds the session", async () => {
    // The widening must not manufacture a parent: a part for a session that
    // genuinely does not exist must still be refused, or the desktop would
    // stage invocations against nothing.
    installSessionStoredUnder("some-other-session");

    const result = await ingest(partForSession(LEGACY_RAW_SESSION_ID));

    expect(result).toEqual({
      ok: false,
      error: AgentComponentInvocationSyncRejectReason.SessionMissing,
    });
  });
});
