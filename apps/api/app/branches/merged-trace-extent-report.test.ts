/**
 * ISS-8767 — the cloud read path must SAY when it refused a `tools` extent.
 *
 * The shared fold in `@repo/lib/branches/merged-trace` can only degrade: it is
 * imported into the browser bundle through `packages/app`'s `activeIdleSpans`,
 * where `no-client-debug-logging` bars a log. Without this wiring a producer
 * regression that started emitting impossible extents would be invisible
 * everywhere, so the assertion that matters is that the PRODUCTION entry point
 * (`buildCompleteBranchTrace`) emits — not that the reporter works when called.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({
    ChecksStatus: { UNKNOWN: "UNKNOWN" },
  });
});

const mocks = vi.hoisted(() => ({
  projectAgentSessionDetail: vi.fn(),
  readAgentSessionDetailInputs: vi.fn(),
  warn: vi.fn(),
}));

vi.mock("@/app/agent-sessions/service/session-detail-read", () => ({
  projectAgentSessionDetail: mocks.projectAgentSessionDetail,
  readAgentSessionDetailInputs: mocks.readAgentSessionDetailInputs,
}));

vi.mock("@repo/observability/log", () => ({
  log: { warn: mocks.warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

import { TraceExtentRejection } from "@repo/lib/branches/merged-trace";
import { branchTraceService } from "./branch-trace-service";
import {
  MERGED_TRACE_ITEM_UNREADABLE_EVENT,
  MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT,
  resetMergedTraceExtentThrottle,
} from "./merged-trace-extent-report";

const STARTED_AT = "2026-08-01T00:00:00.000Z";
const START_MS = Date.parse(STARTED_AT);

/**
 * A finite impossible extent: the shape a nanosecond stamp handed over as
 * milliseconds takes, which a `z.number()` boundary happily accepts and only
 * {@link classifyTraceExtentRejection} refuses.
 *
 * ISS-9723 removed the reason `NaN` could not be used here — the per-session
 * schema gate that dropped such a session whole is gone, so a non-finite extent
 * now reaches this reporter too. This fixture stays finite because the case it
 * covers is the one the SCHEMA cannot catch.
 */
const NANOSECOND_STAMP_AS_MS = START_MS * 1_000_000;

describe("merged-trace extent reporting from the branch trace read path", () => {
  beforeEach(() => {
    mocks.projectAgentSessionDetail.mockReset();
    mocks.readAgentSessionDetailInputs.mockReset();
    mocks.warn.mockReset();
    resetMergedTraceExtentThrottle();
    mocks.readAgentSessionDetailInputs.mockResolvedValue([
      { record: { artifactId: "session-000" } },
    ]);
  });

  it("warns with the org, the reason tally, and the refused value", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(NANOSECOND_STAMP_AS_MS)
    );

    const result = await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );

    // The trace itself is unchanged by reporting: detection only.
    expect(result.items.some((item) => item.type === "tools")).toBe(true);
    expect(mocks.warn).toHaveBeenCalledWith(
      MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT,
      expect.objectContaining({
        organizationId: "org-1",
        reasons: [TraceExtentRejection.BeyondRepresentableInstant],
        refusedCount: 1,
        countByReason: {
          [TraceExtentRejection.BeyondRepresentableInstant]: 1,
        },
        sample: [
          {
            sessionId: "session-000",
            reason: TraceExtentRejection.BeyondRepresentableInstant,
            endMs: NANOSECOND_STAMP_AS_MS,
          },
        ],
        occurrences: 1,
      })
    );
  });

  /*
   * #6809 review (whitlockk). A standing `not_finite: 0` on every line would read as
   * a measurement that no producer emits `NaN`, when it is only a reason this
   * request happened not to see — the confident zero the tally must not invite.
   * The assertion is on the KEY, not on a value, because a `0` is what a
   * passing-looking regression emits.
   *
   * ISS-9723 narrowed why that zero would be wrong without changing that it is:
   * `not_finite` used to be structurally unreachable here (the per-session
   * schema gate dropped such a session whole), and is now merely unobserved by
   * THIS request.
   */
  it("omits a reason it did not observe rather than reporting it as zero", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(NANOSECOND_STAMP_AS_MS)
    );

    await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );

    const [, payload] = mocks.warn.mock.calls.at(-1) as [
      string,
      { countByReason: Record<string, number> },
    ];
    expect(Object.keys(payload.countByReason)).toEqual([
      TraceExtentRejection.BeyondRepresentableInstant,
    ]);
    expect(TraceExtentRejection.NotFinite in payload.countByReason).toBe(false);
  });

  /*
   * `apps/api/AGENTS.md` — Emission and Abuse Control. Branch detail is re-read
   * on every navigation and invalidation, so one member holding one branch with
   * one corrupt extent could drive a line per request. The suppressed
   * occurrences are rolled up, never discarded, so the signal survives the
   * bound.
   */
  it("emits once per window for a repeated read and rolls the rest up", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(NANOSECOND_STAMP_AS_MS)
    );

    for (let read = 0; read < 4; read += 1) {
      await branchTraceService.buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions()
      );
    }

    const extentWarns = mocks.warn.mock.calls.filter(
      ([event]) => event === MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT
    );
    expect(extentWarns).toHaveLength(1);
    expect(extentWarns[0][1]).toEqual(
      expect.objectContaining({ occurrences: 1 })
    );
  });

  it("keeps a different org's first refusal out of another org's window", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(NANOSECOND_STAMP_AS_MS)
    );

    await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );
    await branchTraceService.buildCompleteBranchTrace(
      "org-2",
      qualifyingSessions()
    );

    expect(
      mocks.warn.mock.calls
        .filter(([event]) => event === MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT)
        .map(
          ([, payload]) =>
            (payload as { organizationId: string }).organizationId
        )
    ).toEqual(["org-1", "org-2"]);
  });

  it("stays silent when every extent is trustworthy", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(START_MS + 60_000)
    );

    await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );

    expect(mocks.warn).not.toHaveBeenCalledWith(
      MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT,
      expect.anything()
    );
  });

  /*
   * ISS-9723. `not_finite` was structurally unreachable at THIS reporter while
   * the per-session schema gate dropped such a session whole; the caller now
   * reports over the pre-drop build, so it arrives. That is the half of the
   * module docstring's claim a reader cannot check by reading — assert it.
   *
   * The same item also fires the unreadable-item event, because the fold's
   * `!Number.isFinite` branch and Zod's `z.number()` refuse the identical value.
   * Both lines are expected; that overlap is the documented one.
   */
  it("reports a non-finite extent as both a refused extent and a dropped item", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(Number.NaN)
    );

    await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );

    expect(warnPayload(MERGED_TRACE_TOOL_EXTENT_INVALID_EVENT)).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        countByReason: { [TraceExtentRejection.NotFinite]: 1 },
      })
    );
    expect(warnPayload(MERGED_TRACE_ITEM_UNREADABLE_EVENT)).toEqual(
      expect.objectContaining({
        organizationId: "org-1",
        sessionCount: 1,
        totalUnreadableItemCount: 1,
        sample: [{ sessionId: "session-000", count: 1 }],
        occurrences: 1,
      })
    );
  });

  it("stays silent about unreadable items when every item parses", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(START_MS + 60_000)
    );

    await branchTraceService.buildCompleteBranchTrace(
      "org-1",
      qualifyingSessions()
    );

    expect(warnPayload(MERGED_TRACE_ITEM_UNREADABLE_EVENT)).toBeUndefined();
  });

  /* Same Emission and Abuse Control bound as its sibling, on the same read path. */
  it("bounds the unreadable-item event per org and rolls suppressed reads up", async () => {
    mocks.projectAgentSessionDetail.mockReturnValue(
      detailWithToolExtent(Number.NaN)
    );

    for (let read = 0; read < 4; read += 1) {
      await branchTraceService.buildCompleteBranchTrace(
        "org-1",
        qualifyingSessions()
      );
    }
    await branchTraceService.buildCompleteBranchTrace(
      "org-2",
      qualifyingSessions()
    );

    // One line per org: org-1's three repeats are suppressed into its window,
    // and org-2 is not silenced by org-1 holding the only key.
    expect(
      mocks.warn.mock.calls
        .filter(([event]) => event === MERGED_TRACE_ITEM_UNREADABLE_EVENT)
        .map(
          ([, payload]) =>
            (payload as { organizationId: string }).organizationId
        )
    ).toEqual(["org-1", "org-2"]);
  });
});

/** The most recent payload logged under `event`, or undefined if none was. */
function warnPayload(event: string): Record<string, unknown> | undefined {
  const call = mocks.warn.mock.calls.filter(([name]) => name === event).at(-1);
  return call?.[1] as Record<string, unknown> | undefined;
}

function detailWithToolExtent(endMs: number) {
  return {
    id: "session-000",
    name: "session-000",
    slug: "SESSION-000",
    externalSessionId: "external-session-000",
    harness: "codex",
    model: "gpt",
    primaryModel: "gpt",
    startedAt: new Date(STARTED_AT),
    turnItems: [
      {
        type: "tools",
        _row: 0,
        t: STARTED_AT,
        tMs: START_MS,
        endMs,
        cum: 0,
        actor: {
          name: "alice",
          sessionId: "session-000",
          human: "alice",
          color: "",
        },
        summary: "1 tool",
        items: [],
        hasFail: false,
        failN: 0,
        cats: {},
      },
    ],
  };
}

function qualifyingSessions() {
  return [
    {
      observedAtMs: START_MS,
      identity: {
        artifactId: "session-000",
        name: "Session 0",
        slug: "SES-0",
        navigableRef: "SES-0",
        externalSessionId: "external-session-000",
      },
    },
  ];
}
