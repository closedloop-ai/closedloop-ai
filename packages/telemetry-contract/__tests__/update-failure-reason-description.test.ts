import { describe, expect, it } from "vitest";
import { UpdateEvent } from "../app";
import { CompatibilityAttributeProducerMapping } from "../src/attribute-producer-mapping";
import { TelemetryAttribute } from "../src/attributes";

/**
 * ISS-7291: the published `update.failure_reason` description drifted from its
 * producer once already — it named two of the four events that carry the
 * attribute, so a consumer building the failure population dropped half the
 * fleet. Nothing pinned the prose, which is why the drift outlived review.
 *
 * These cases pin the two partitions a consumer actually reads off this
 * description, and nothing else about its wording.
 */

/** The `update.event` values the desktop producer attaches a failure reason to. */
const FAILURE_REASON_PRODUCING_EVENTS = [
  UpdateEvent.CheckFailed,
  UpdateEvent.DownloadFailed,
  UpdateEvent.InstallBlocked,
  UpdateEvent.RestartFailed,
] as const;

/**
 * The events that can carry `permission`: hardcoded on `install_blocked`, and
 * read out of the updater's message by the ONE shared classifier that
 * `check_failed` and `download_failed` both call — so the transient arm is not
 * `download_failed` alone.
 */
const PERMISSION_PRODUCING_EVENTS = [
  UpdateEvent.CheckFailed,
  UpdateEvent.DownloadFailed,
  UpdateEvent.InstallBlocked,
] as const;

/**
 * Isolates the `permission` overload sentence from the enumeration above it, so
 * an event named only in the four-event list cannot satisfy the overload case.
 */
const PERMISSION_OVERLOAD_SEGMENT = /`permission` is overloaded[\s\S]*$/;

describe("update.failure_reason producer description", () => {
  const { reason } =
    CompatibilityAttributeProducerMapping[
      TelemetryAttribute.UpdateFailureReason
    ];

  it("names every event that carries the attribute", () => {
    for (const event of FAILURE_REASON_PRODUCING_EVENTS) {
      expect(
        reason,
        `description must name \`${event}\` as carrying update.failure_reason`
      ).toContain(event);
    }
  });

  it("names every permission-producing event in the overload sentence", () => {
    const segment = reason.match(PERMISSION_OVERLOAD_SEGMENT)?.[0];
    expect(
      segment,
      "description must explain the `permission` overload"
    ).toBeDefined();
    for (const event of PERMISSION_PRODUCING_EVENTS) {
      expect(
        segment,
        `permission overload must name \`${event}\` — it shares one classifier with the other transient arm`
      ).toContain(event);
    }
  });
});
