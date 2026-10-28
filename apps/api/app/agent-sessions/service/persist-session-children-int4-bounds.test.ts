/**
 * ISS-8881 §1 and §3: the session counters that reach Postgres `int4` columns
 * are screened at the WRITE, and an unstorable one omits its field rather than
 * failing the slice.
 *
 * §1 `turns` / `steeringEpisodes` land in `SessionDetail.turns` /
 * `.steering_episodes` (`Int?`), 21 lines below `boundedLocFieldSchema` whose
 * comment names this exact failure. §3 the five `AgentSessionUsageRollup`
 * counters land in `Int @default(0)` columns.
 *
 * The wire is deliberately NOT bounded: `parseDesktopAgentSessionsPayload` is
 * ONE `safeParse` over a batch of up to 200 sessions, so a rejecting `.max()`
 * would turn one corrupt counter into a 400 for the whole batch, re-sent
 * unchanged forever (ISS-8051).
 */
import type { SyncedAgentSession } from "@repo/api/src/types/agent-session";
import { PR_INT_MAX } from "@repo/api/src/types/session-artifact-link";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { buildSyncedSession } from "@/__tests__/support/agent-sessions/service.test-harness";
import {
  persistSessionChildren,
  toTraceDetailPatch,
} from "./persist-session-children";
import {
  UNSTORABLE_ROLLUP_FIELD_PREFIX,
  UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX,
} from "./session-sync-metrics";

vi.mock("@repo/database", async () => {
  const { databaseModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return databaseModuleMock();
});

vi.mock("@repo/observability/telemetry/metrics", async () => {
  const { telemetryModuleMock } = await import(
    "@/__tests__/support/agent-sessions/service.test-mocks"
  );
  return telemetryModuleMock();
});

const ARTIFACT_ID = "a-1";
const ORGANIZATION_ID = "org-1";

function traceSession(
  overrides: Partial<SyncedAgentSession>
): SyncedAgentSession {
  return buildSyncedSession(overrides) as unknown as SyncedAgentSession;
}

/** The patch `toTraceDetailPatch` builds, plus the fields it refused. */
function buildPatch(overrides: Partial<SyncedAgentSession>) {
  const unstorableCounterFields: string[] = [];
  const patch = toTraceDetailPatch(traceSession(overrides), {
    unstorableCounterFields,
  });
  return { patch, unstorableCounterFields };
}

function txWithSpies() {
  const rollupUpsert = vi.fn().mockResolvedValue({ artifactId: ARTIFACT_ID });
  const sessionDetailUpdate = vi
    .fn()
    .mockResolvedValue({ artifactId: ARTIFACT_ID });
  const tx = {
    $executeRawUnsafe: vi.fn(),
    $queryRawUnsafe: vi
      .fn()
      .mockResolvedValue([
        { toolUseCount: 0n, errorCount: 0n, maxEventCreatedAt: null },
      ]),
    agentSessionActivitySegment: {
      createMany: vi.fn(),
      deleteMany: vi.fn(),
      findFirst: vi.fn(),
    },
    agentSessionEvent: { deleteMany: vi.fn() },
    agentSessionTokenEvent: { createMany: vi.fn() },
    agentSessionTokenUsage: { createMany: vi.fn(), deleteMany: vi.fn() },
    agentSessionUsageRollup: { upsert: rollupUpsert },
    artifact: { findFirst: vi.fn() },
    sessionDetail: { update: sessionDetailUpdate },
  };
  return { rollupUpsert, sessionDetailUpdate, tx };
}

const SOUND_ANALYTICS = {
  agentTurns: 2,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  errorEvents: 0,
  estimatedCostUsd: 1.5,
  eventCount: 3,
  harness: "claude",
  humanTurns: 1,
  inputTokens: 10,
  isHuman: true,
  outputTokens: 5,
  startedAt: "2026-08-01T00:00:00.000Z",
  startedDay: "2026-08-01",
  status: "inactive",
  toolInvocations: 4,
};

async function persistWithAnalytics(
  analyticsOverrides: Record<string, unknown>
) {
  const { rollupUpsert, sessionDetailUpdate, tx } = txWithSpies();
  const session = buildSyncedSession({ events: [] }) as Record<string, unknown>;
  session.sessionAnalytics = { ...SOUND_ANALYTICS, ...analyticsOverrides };
  const result = await persistSessionChildren(
    tx as unknown as Parameters<typeof persistSessionChildren>[0],
    ARTIFACT_ID,
    ORGANIZATION_ID,
    session as never,
    [],
    {
      // Non-terminal: the rollup guard is not what these bound cases exercise.
      guardedStatus: SESSION_STATUS.ACTIVE,
      shouldReplace: false,
      shouldUpdateTokenEventCosts: true,
    }
  );
  return { result, rollupUpsert, sessionDetailUpdate };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("§1 turns / steeringEpisodes are screened at the write (ISS-8881)", () => {
  it("omits the key for an unstorable value and keeps its siblings", () => {
    // The key must be ABSENT, not `undefined`-valued: absence is the contract
    // that leaves the column alone, and it is what `"turns" in patch` proves.
    // `autonomy` beside it is already bounded on the wire, so its survival is
    // what separates "drop the field" from "drop the session".
    const { patch, unstorableCounterFields } = buildPatch({
      autonomy: 55,
      steeringEpisodes: 4,
      turns: 2 ** 31,
    } as Partial<SyncedAgentSession>);

    expect("turns" in patch).toBe(false);
    expect(patch.steeringEpisodes).toBe(4);
    expect(patch.autonomy).toBe(55);
    expect(unstorableCounterFields).toEqual([
      `${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`,
    ]);
  });

  it("still CLEARS the column on an explicit null", () => {
    // THE COMPATIBILITY CASE. These fields are `.nullable().optional()` on the
    // wire and `Int?` in the column, and today a null CLEARS the column — valid
    // input with a defined meaning. A naive "is this a storable int4" predicate
    // rejects null and turns that clear into a no-op, which is a behaviour
    // change on VALID input. This is the mutation it kills.
    const { patch, unstorableCounterFields } = buildPatch({
      steeringEpisodes: null,
      turns: null,
    } as Partial<SyncedAgentSession>);

    expect(patch.turns).toBeNull();
    expect(patch.steeringEpisodes).toBeNull();
    expect(unstorableCounterFields).toEqual([]);
  });

  it("leaves the column untouched when the payload omits the field", () => {
    // Omission never clears — the rule the whole patch builder is written to.
    const { patch, unstorableCounterFields } = buildPatch({});

    expect("turns" in patch).toBe(false);
    expect("steeringEpisodes" in patch).toBe(false);
    expect(unstorableCounterFields).toEqual([]);
  });

  it.each([
    ["the exact int4 ceiling", PR_INT_MAX],
    ["one below the ceiling", PR_INT_MAX - 1],
    ["zero", 0],
  ])("stores %s unchanged", (_label, turns) => {
    // Catches an over-rejecting guard, and pins the boundary itself — the
    // `>` vs `>=` mutation that survived the pre-change mutation run on the
    // sibling predicate in `component-usage.ts`.
    const { patch, unstorableCounterFields } = buildPatch({
      turns,
    } as Partial<SyncedAgentSession>);

    expect(patch.turns).toBe(turns);
    expect(unstorableCounterFields).toEqual([]);
  });

  it.each([
    ["one past the ceiling", PR_INT_MAX + 1],
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite", Number.POSITIVE_INFINITY],
    ["NaN", Number.NaN],
  ])("omits %s", (_label, turns) => {
    // The whole impossible set. A fractional or negative turn count is as
    // fabricated a measurement as an overflowed one.
    const { patch, unstorableCounterFields } = buildPatch({
      turns,
    } as Partial<SyncedAgentSession>);

    expect("turns" in patch).toBe(false);
    expect(unstorableCounterFields).toEqual([
      `${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}turns`,
    ]);
  });

  it("screens steeringEpisodes on the same terms", () => {
    const { patch, unstorableCounterFields } = buildPatch({
      steeringEpisodes: 2 ** 31,
      turns: 9,
    } as Partial<SyncedAgentSession>);

    expect(patch.turns).toBe(9);
    expect("steeringEpisodes" in patch).toBe(false);
    expect(unstorableCounterFields).toEqual([
      `${UNSTORABLE_SESSION_DETAIL_FIELD_PREFIX}steeringEpisodes`,
    ]);
  });

  it("never substitutes the ceiling for an unstorable value", () => {
    // ANTI-CLAMP. Kills `Math.min(value, PR_INT_MAX)`, which stops the 22003 and
    // stores a number no reader can tell from a real count (#6370).
    const { patch } = buildPatch({
      steeringEpisodes: 2 ** 31,
      turns: 2 ** 31,
    } as Partial<SyncedAgentSession>);

    expect(patch.turns).not.toBe(PR_INT_MAX);
    expect(patch.steeringEpisodes).not.toBe(PR_INT_MAX);
  });
});

describe("§3 the usage rollup is valid-or-absent as a whole row (ISS-8881)", () => {
  it("writes the rollup unchanged when all five counters are storable", async () => {
    // The byte-identical path. Every VALID payload must still take today's exact
    // upsert — if this reddens, the guard changed behaviour on sound input,
    // which the ticket forbids outright.
    const { result, rollupUpsert } = await persistWithAnalytics({});

    expect(rollupUpsert).toHaveBeenCalledTimes(1);
    const call = rollupUpsert.mock.calls[0][0];
    expect(call.create).toEqual(
      expect.objectContaining({
        agentTurns: 2,
        artifactId: ARTIFACT_ID,
        errorEvents: 0,
        eventCount: 3,
        humanTurns: 1,
        toolInvocations: 4,
      })
    );
    expect(result.unstorableCounterFields).toEqual([]);
  });

  it.each([
    ["humanTurns"],
    ["agentTurns"],
    ["eventCount"],
    ["toolInvocations"],
    ["errorEvents"],
  ])("withholds the WHOLE row when %s is unstorable", async (field) => {
    // Not a partial write. All five columns are `Int @default(0)` NOT NULL, so
    // the row can express neither "absent" nor "unknown" for one of them: on a
    // create an omitted key stores a real 0, and on an update a per-field
    // omission leaves the PRIOR sync's counter beside this sync's tokens while
    // `lastSyncedAt` is stamped current — a composite no reader can tell from a
    // real snapshot. Root AGENTS.md: store a valid record or nothing.
    const { result, rollupUpsert } = await persistWithAnalytics({
      [field]: 2 ** 31,
    });

    expect(rollupUpsert).not.toHaveBeenCalled();
    expect(result.unstorableCounterFields).toEqual([
      `${UNSTORABLE_ROLLUP_FIELD_PREFIX}${field}`,
    ]);
  });

  it("reports every unstorable counter, not just the first", async () => {
    // A per-field report, so the operator sees the whole shape of the corruption.
    const { result } = await persistWithAnalytics({
      errorEvents: -1,
      eventCount: 2 ** 31,
    });

    expect(result.unstorableCounterFields).toEqual(
      expect.arrayContaining([
        `${UNSTORABLE_ROLLUP_FIELD_PREFIX}eventCount`,
        `${UNSTORABLE_ROLLUP_FIELD_PREFIX}errorEvents`,
      ])
    );
  });

  it("still writes the displayed session cost when the rollup is withheld", async () => {
    // `SessionDetail.estimatedCost` is a DIFFERENT table and independently
    // valid, so withholding the rollup must not discard it too. Kills a fix that
    // early-returns out of `persistSessionAnalytics` entirely.
    const { sessionDetailUpdate } = await persistWithAnalytics({
      eventCount: 2 ** 31,
    });

    expect(sessionDetailUpdate).toHaveBeenCalledTimes(1);
    expect(sessionDetailUpdate.mock.calls[0][0].data.estimatedCost).toBe(1.5);
  });

  it.each([
    ["the exact int4 ceiling", PR_INT_MAX],
    ["one below the ceiling", PR_INT_MAX - 1],
  ])("still writes the row for %s", async (_label, eventCount) => {
    const { result, rollupUpsert } = await persistWithAnalytics({ eventCount });

    expect(rollupUpsert).toHaveBeenCalledTimes(1);
    expect(rollupUpsert.mock.calls[0][0].create.eventCount).toBe(eventCount);
    expect(result.unstorableCounterFields).toEqual([]);
  });

  it("never substitutes the ceiling for an unstorable counter", async () => {
    // ANTI-CLAMP for the rollup arm.
    const { rollupUpsert } = await persistWithAnalytics({
      eventCount: 2 ** 31,
    });

    expect(rollupUpsert).not.toHaveBeenCalled();
  });
});
