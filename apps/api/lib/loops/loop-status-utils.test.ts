/**
 * Coverage for the loop→generation status projection (40% → covered).
 *
 * These two mappers decide what a document's status panel shows, and
 * `pickBestStatus` decides which of two competing loops wins that slot — an
 * active loop must never be hidden behind a finished one.
 */

import { LoopCommand, LoopStatus } from "@repo/api/src/types/loop";
import { describe, expect, it } from "vitest";
import {
  mapLoopCommand,
  mapLoopStatus,
  NONE_STATUS,
  pickBestStatus,
} from "./loop-status-utils";

const status = (
  overrides: Partial<Parameters<typeof pickBestStatus>[0] & object> = {}
) =>
  ({ ...NONE_STATUS, ...overrides }) as NonNullable<
    Parameters<typeof pickBestStatus>[0]
  >;

describe("mapLoopStatus", () => {
  it("maps the in-flight states", () => {
    expect(mapLoopStatus(LoopStatus.Pending)).toBe("PENDING");
    expect(mapLoopStatus(LoopStatus.Claimed)).toBe("QUEUED");
    expect(mapLoopStatus(LoopStatus.Running)).toBe("RUNNING");
  });

  it("surfaces a BLOCKED loop as PENDING, not as absent", () => {
    // A deferred/blocker-gated loop is queued work that starts automatically
    // once unblocked; dropping it would make the status panel look idle while
    // work is genuinely scheduled.
    expect(mapLoopStatus(LoopStatus.Blocked)).toBe("PENDING");
  });

  it("maps success and every failure mode", () => {
    expect(mapLoopStatus(LoopStatus.Completed)).toBe("SUCCESS");
    expect(mapLoopStatus(LoopStatus.Failed)).toBe("FAILURE");
    expect(mapLoopStatus(LoopStatus.Cancelled)).toBe("FAILURE");
    expect(mapLoopStatus(LoopStatus.TimedOut)).toBe("FAILURE");
  });

  it("returns null for a status this build does not recognize", () => {
    expect(mapLoopStatus("SOMETHING_NEW" as unknown as LoopStatus)).toBeNull();
  });

  it("maps every declared LoopStatus member to a non-null value", () => {
    // Guards the enum against drift: a newly added member that nobody mapped
    // would fall to the default and silently vanish from the panel.
    for (const member of Object.values(LoopStatus)) {
      expect(mapLoopStatus(member)).not.toBeNull();
    }
  });
});

describe("mapLoopCommand", () => {
  it("lowercases and snake_cases each declared command", () => {
    expect(mapLoopCommand(LoopCommand.Plan)).toBe("plan");
    expect(mapLoopCommand(LoopCommand.RequestChanges)).toBe("request_changes");
    expect(mapLoopCommand(LoopCommand.EvaluatePrd)).toBe("evaluate_prd");
    expect(mapLoopCommand(LoopCommand.GeneratePrd)).toBe("generate_prd");
  });

  it("returns null for an unrecognized command", () => {
    expect(
      mapLoopCommand("FUTURE_COMMAND" as unknown as LoopCommand)
    ).toBeNull();
  });

  it("deliberately returns null for the commands the status panel cannot show", () => {
    // GenerationStatus["command"] is a CLOSED union of 12 lowercase values plus
    // null. BOOTSTRAP and MANUAL have no member in it, so null is the correct
    // answer — not an unmapped-enum bug. Pinned so a later edit cannot "fix"
    // them into a value the contract does not admit.
    expect(mapLoopCommand(LoopCommand.Bootstrap)).toBeNull();
    expect(mapLoopCommand(LoopCommand.Manual)).toBeNull();
  });

  it("covers every value the GenerationStatus command union admits", () => {
    // The useful exhaustiveness direction: no member of the target union is
    // unreachable, so a newly added command that DOES belong on the panel has
    // somewhere to land.
    const produced = new Set(
      Object.values(LoopCommand)
        .map(mapLoopCommand)
        .filter((c): c is NonNullable<typeof c> => c !== null)
    );

    expect(produced).toEqual(
      new Set([
        "plan",
        "execute",
        "chat",
        "explore",
        "request_changes",
        "request_prd_changes",
        "generate_prd",
        "decompose",
        "evaluate_prd",
        "evaluate_plan",
        "evaluate_code",
        "evaluate_feature",
      ])
    );
  });
});

describe("pickBestStatus", () => {
  const running = status({ status: "RUNNING", startedAt: new Date(1000) });
  const succeeded = status({ status: "SUCCESS", startedAt: new Date(9000) });

  it("prefers an active status over a terminal one, regardless of recency", () => {
    // The active loop started EARLIER, and must still win — recency is only a
    // tiebreak within the same activity class.
    expect(pickBestStatus(running, succeeded)).toBe(running);
    expect(pickBestStatus(succeeded, running)).toBe(running);
  });

  it("prefers the most recent when both are terminal", () => {
    const older = status({ status: "FAILURE", startedAt: new Date(1000) });
    const newer = status({ status: "SUCCESS", startedAt: new Date(2000) });

    expect(pickBestStatus(older, newer)).toBe(newer);
    expect(pickBestStatus(newer, older)).toBe(newer);
  });

  it("prefers the most recent when both are active", () => {
    const older = status({ status: "RUNNING", startedAt: new Date(1000) });
    const newer = status({ status: "PENDING", startedAt: new Date(2000) });

    expect(pickBestStatus(older, newer)).toBe(newer);
  });

  it("treats a missing startedAt as the epoch rather than throwing", () => {
    const undated = status({ status: "SUCCESS", startedAt: null });
    const dated = status({ status: "FAILURE", startedAt: new Date(5) });

    expect(pickBestStatus(undated, dated)).toBe(dated);
  });

  it("breaks an exact startedAt tie in favor of b", () => {
    const a = status({ status: "SUCCESS", startedAt: new Date(1000) });
    const b = status({ status: "FAILURE", startedAt: new Date(1000) });

    expect(pickBestStatus(a, b)).toBe(b);
  });

  it("returns whichever side is present when the other is null", () => {
    expect(pickBestStatus(running, null)).toBe(running);
    expect(pickBestStatus(null, running)).toBe(running);
  });

  it("falls back to NONE_STATUS when both are null", () => {
    expect(pickBestStatus(null, null)).toBe(NONE_STATUS);
  });
});
