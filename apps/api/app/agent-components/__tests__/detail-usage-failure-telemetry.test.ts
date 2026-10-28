/**
 * whitlockk (#7051 review): a detail usage aggregate that times out on every
 * refresh must not emit one error event per refresh. `apps/api/AGENTS.md`
 * "Emission and Abuse Control": bound per (org, reason) and keep a suppressed
 * count. These cases pin the bound and the rollup the monitor still receives.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ logError: vi.fn() }));

vi.mock("@repo/observability/log", () => ({
  log: { error: mocks.logError, info: vi.fn(), warn: vi.fn() },
}));

import {
  EmissionRollupCause,
  FIXED_WINDOW_EMISSION_WINDOW_MS,
} from "@/lib/observability/fixed-window-emission-throttle";
import {
  DetailUsageAggregateFailedEvent,
  detailUsageAggregateFailureThrottle,
  reportDetailUsageAggregateFailure,
} from "../detail-usage-failure-telemetry";

const ORG_A = "org-a";
const ORG_B = "org-b";
const KIND = "skill";
const START = new Date("2026-09-11T12:00:00.000Z");

describe("reportDetailUsageAggregateFailure (#7051 review)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(START);
    detailUsageAggregateFailureThrottle.clear();
    mocks.logError.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("emits the first failure per (org, event) in a window and suppresses the repeats", () => {
    for (let attempt = 0; attempt < 5; attempt += 1) {
      reportDetailUsageAggregateFailure(
        DetailUsageAggregateFailedEvent.Totals,
        ORG_A,
        { kind: KIND }
      );
    }

    expect(mocks.logError.mock.calls).toEqual([
      [
        DetailUsageAggregateFailedEvent.Totals,
        { kind: KIND, organizationId: ORG_A, occurrences: 1 },
      ],
    ]);
  });

  it("keys on the org and the event, so neither spends the other's budget", () => {
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.Totals,
      ORG_A,
      {}
    );
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.SeenBounds,
      ORG_A,
      {}
    );
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.Totals,
      ORG_B,
      {}
    );

    expect(
      mocks.logError.mock.calls.map(([event, fields]) => [
        event,
        fields.organizationId,
      ])
    ).toEqual([
      [DetailUsageAggregateFailedEvent.Totals, ORG_A],
      [DetailUsageAggregateFailedEvent.SeenBounds, ORG_A],
      [DetailUsageAggregateFailedEvent.Totals, ORG_B],
    ]);
  });

  it("flushes the suppressed count as a rollup when the next window opens", () => {
    for (let attempt = 0; attempt < 3; attempt += 1) {
      reportDetailUsageAggregateFailure(
        DetailUsageAggregateFailedEvent.Totals,
        ORG_A,
        { kind: KIND }
      );
    }
    vi.setSystemTime(START.getTime() + FIXED_WINDOW_EMISSION_WINDOW_MS);
    reportDetailUsageAggregateFailure(
      DetailUsageAggregateFailedEvent.Totals,
      ORG_A,
      { kind: KIND }
    );

    expect(mocks.logError.mock.calls.slice(1)).toEqual([
      [
        DetailUsageAggregateFailedEvent.Totals,
        {
          organizationId: ORG_A,
          occurrences: 2,
          aggregated: true,
          flushedBy: EmissionRollupCause.Window,
        },
      ],
      [
        DetailUsageAggregateFailedEvent.Totals,
        { kind: KIND, organizationId: ORG_A, occurrences: 1 },
      ],
    ]);
  });
});
