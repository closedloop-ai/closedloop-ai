/**
 * ISS-9443: the priority telemetry emit itself.
 *
 * Two contracts, both load-bearing and neither visible from the routes that
 * call this module: the event name and property set that every dashboard reads
 * (renaming either orphans them silently), and FAILURE-ISOLATION, a PostHog
 * outage must not reach the write the user just made.
 */
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { Priority } from "@repo/api/src/types/common";
import { ArtifactPriorityCommitResult } from "@repo/api/src/types/priority-contract";
import { describe, expect, it, vi } from "vitest";

const capture = vi.hoisted(() => vi.fn());
const logError = vi.hoisted(() => vi.fn());

// Runs the scheduled promise here rather than on the response path, which is
// what lets these cases observe the emit at all, and what proves the caller
// never awaits it.
const scheduled = vi.hoisted(() => [] as Promise<unknown>[]);
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((p: Promise<unknown>) => {
    scheduled.push(Promise.resolve(p).catch(() => undefined));
  }),
}));

vi.mock("@repo/analytics/server", () => ({
  analytics: { captureImmediate: (...args: unknown[]) => capture(...args) },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn() },
}));

import {
  ARTIFACT_PRIORITY_CHANGED_EVENT,
  captureArtifactPriorityChangeAnalytics,
} from "../artifact-priority-analytics";

const INPUT = {
  organizationId: "org-1",
  userId: "user-1",
  surface: ArtifactStatusEditSurface.Bulk,
  result: ArtifactPriorityCommitResult.Committed,
  from: Priority.Low,
  to: Priority.High,
  artifactCount: 7,
} as const;

async function flush(): Promise<void> {
  await Promise.all(scheduled.splice(0, scheduled.length));
}

describe("captureArtifactPriorityChangeAnalytics", () => {
  it("emits the named event with the surface, result, values and count", async () => {
    capture.mockResolvedValue(undefined);

    captureArtifactPriorityChangeAnalytics({ ...INPUT });
    await flush();

    expect(capture).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: ARTIFACT_PRIORITY_CHANGED_EVENT,
      properties: {
        organizationId: "org-1",
        surface: ArtifactStatusEditSurface.Bulk,
        result: ArtifactPriorityCommitResult.Committed,
        from: Priority.Low,
        to: Priority.High,
        artifactCount: 7,
      },
    });
  });

  it("carries no artifact content, the property set is closed", async () => {
    capture.mockResolvedValue(undefined);

    captureArtifactPriorityChangeAnalytics({ ...INPUT });
    await flush();

    // A title, an id or an assignee arriving here would ship artifact content
    // to a product-analytics sink that is not entitled to it.
    expect(
      Object.keys(capture.mock.calls[0]?.[0].properties ?? {}).sort()
    ).toEqual([
      "artifactCount",
      "from",
      "organizationId",
      "result",
      "surface",
      "to",
    ]);
  });

  it("OMITS `from` when the commit named no single prior, and never sends null", async () => {
    capture.mockResolvedValue(undefined);

    // A bulk commit spans as many priors as it has rows. `null` is already
    // spoken for, it means the artifact held NO priority, so serializing it
    // here would report a measured transition out of "unprioritized" that
    // nobody observed.
    // Cleared explicitly: nothing in this file resets the spy between cases, so
    // reading `calls[0]` would otherwise inspect the FIRST test's emit, which
    // carries a `from` and would fail this assertion for the wrong reason.
    capture.mockClear();
    const { from: _omitted, ...withoutFrom } = INPUT;
    captureArtifactPriorityChangeAnalytics({ ...withoutFrom });
    await flush();

    const properties = capture.mock.calls[0]?.[0].properties;
    expect(Object.hasOwn(properties, "from")).toBe(false);
    expect(properties.from).toBeUndefined();

    // Positive control on the SAME selector: the absence above is only
    // meaningful if a supplied `from` does land under this exact key, so a
    // silently-dropped property cannot pass as deliberate omission.
    capture.mockClear();
    captureArtifactPriorityChangeAnalytics({ ...INPUT, from: null });
    await flush();
    const withNull = capture.mock.calls[0]?.[0].properties;
    expect(Object.hasOwn(withNull, "from")).toBe(true);
    expect(withNull.from).toBeNull();
  });

  it("swallows a capture failure instead of surfacing it to the caller", async () => {
    capture.mockRejectedValue(new Error("posthog is down"));

    // The synchronous call must not throw, and the scheduled work must settle
    // rather than reject, a rejection here is an unhandled one in production.
    expect(() =>
      captureArtifactPriorityChangeAnalytics({ ...INPUT })
    ).not.toThrow();
    await expect(flush()).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalled();
  });
});
