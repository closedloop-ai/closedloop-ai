import { describe, expect, it } from "vitest";
import { createAgentSessionListItemFixture } from "../../components/sessions/session-list-fixtures";
import {
  ACTIVE_RUN_PHASE_KIND,
  ACTIVE_RUN_STALL_TIMEOUT_MS,
  activeRunTokenBurn,
  deriveActiveRun,
  deriveActiveRuns,
} from "../active-runs";

const NOW = new Date("2026-06-01T15:00:00.000Z").getTime();

function activeItem(overrides: Record<string, unknown> = {}) {
  return createAgentSessionListItemFixture({
    status: "active",
    awaitingInputSince: null,
    endedAt: null,
    lastActivityAt: new Date(NOW - 30_000),
    phases: [
      {
        key: "plan",
        label: "Planning",
        dur: "1m",
        cost: "$0",
        cIn: 0,
        cOut: 0,
        cCache: 0,
      },
      {
        key: "stream",
        label: "Streaming turn",
        dur: "2m",
        cost: "$0",
        cIn: 0,
        cOut: 0,
        cCache: 0,
      },
    ],
    ...overrides,
  });
}

describe("activeRunTokenBurn", () => {
  it("sums input, output, and cache token traffic", () => {
    const item = activeItem({
      inputTokens: 48_000,
      outputTokens: 12_000,
      cacheReadTokens: 1200,
      cacheWriteTokens: 400,
    });
    expect(activeRunTokenBurn(item)).toBe(61_600);
  });
});

describe("deriveActiveRun", () => {
  it("reports the latest synced phase label while working", () => {
    const run = deriveActiveRun(activeItem(), NOW);
    expect(run.phaseKind).toBe(ACTIVE_RUN_PHASE_KIND.Working);
    expect(run.phaseLabel).toBe("Streaming turn");
    expect(run.isStalled).toBe(false);
  });

  it("falls back to a generic working label when no phases are synced", () => {
    const run = deriveActiveRun(activeItem({ phases: [] }), NOW);
    expect(run.phaseLabel).toBe("Working");
  });

  it("flags a stall once activity passes the stall timeout", () => {
    const item = activeItem({
      lastActivityAt: new Date(NOW - ACTIVE_RUN_STALL_TIMEOUT_MS - 1000),
    });
    const run = deriveActiveRun(item, NOW);
    expect(run.isStalled).toBe(true);
    expect(run.phaseKind).toBe(ACTIVE_RUN_PHASE_KIND.Stalled);
    expect(run.phaseLabel).toBe("Stalled");
  });

  it("treats awaiting-input as a paused phase, not a stall", () => {
    const item = activeItem({
      awaitingInputSince: new Date(NOW - ACTIVE_RUN_STALL_TIMEOUT_MS - 1000),
      lastActivityAt: new Date(NOW - ACTIVE_RUN_STALL_TIMEOUT_MS - 1000),
    });
    const run = deriveActiveRun(item, NOW);
    expect(run.awaitingInput).toBe(true);
    expect(run.isStalled).toBe(false);
    expect(run.phaseKind).toBe(ACTIVE_RUN_PHASE_KIND.AwaitingInput);
    expect(run.phaseLabel).toBe("Awaiting input");
  });

  it("clamps inactivity to zero when activity is in the future (clock skew)", () => {
    const run = deriveActiveRun(
      activeItem({ lastActivityAt: new Date(NOW + 5000) }),
      NOW
    );
    expect(run.inactiveForMs).toBe(0);
  });
});

describe("deriveActiveRuns", () => {
  it("orders stalled first, then awaiting, then working", () => {
    const working = activeItem({
      id: "work",
      lastActivityAt: new Date(NOW - 1000),
    });
    const stalled = activeItem({
      id: "stall",
      lastActivityAt: new Date(NOW - ACTIVE_RUN_STALL_TIMEOUT_MS - 1000),
    });
    const awaiting = activeItem({
      id: "await",
      awaitingInputSince: new Date(NOW - 2000),
    });
    const runs = deriveActiveRuns([working, awaiting, stalled], NOW);
    expect(runs.map((run) => run.id)).toEqual(["stall", "await", "work"]);
  });

  it("breaks ties within a phase by most-recent activity first", () => {
    const recentlyStalled = activeItem({
      id: "stall-recent",
      lastActivityAt: new Date(NOW - 6 * 60 * 1000),
    });
    const olderStalled = activeItem({
      id: "stall-old",
      lastActivityAt: new Date(NOW - 8 * 60 * 1000),
    });
    const runs = deriveActiveRuns([olderStalled, recentlyStalled], NOW);
    expect(runs.map((run) => run.id)).toEqual(["stall-recent", "stall-old"]);
  });
});
