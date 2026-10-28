/**
 * ISS-9436: the aggregate half of the status receipt.
 *
 * What is proved here is what a route test cannot see: the exact event name and
 * property shape that reaches PostHog (a wire contract, renaming either
 * orphans a dashboard), that the send is AWAITED through `waitUntil` rather
 * than queued and abandoned, and that a delivery failure stays off the caller's
 * write path.
 */
import { ArtifactStatusCommitResult } from "@repo/api/src/types/artifact-activity";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const captureImmediate = vi.hoisted(() => vi.fn());
const capture = vi.hoisted(() => vi.fn());
const scheduled = vi.hoisted(() => [] as Promise<unknown>[]);

vi.mock("@repo/analytics/server", () => ({
  analytics: { capture, captureImmediate },
}));

// Records what was handed to `waitUntil` so a test can assert the send was
// scheduled off the response path AND await its settlement.
vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    scheduled.push(Promise.resolve(promise).catch(() => undefined));
  }),
}));

const logError = vi.hoisted(() => vi.fn());
vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn() },
}));

import {
  ARTIFACT_STATUS_CHANGED_EVENT,
  captureArtifactStatusChangeAnalytics,
} from "../artifact-status-analytics";

const BASE = {
  organizationId: "org-1",
  userId: "user-1",
  surface: ArtifactStatusEditSurface.Bulk,
  result: ArtifactStatusCommitResult.Committed,
  from: "DRAFT" as string | null | undefined,
  to: "IN_REVIEW",
  artifactCount: 3,
};

async function settle(): Promise<void> {
  await Promise.all(scheduled);
}

beforeEach(() => {
  scheduled.length = 0;
  captureImmediate.mockReset().mockResolvedValue(undefined);
  capture.mockReset();
  logError.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("captureArtifactStatusChangeAnalytics", () => {
  it("captures the canonical event name and property shape", async () => {
    captureArtifactStatusChangeAnalytics(BASE);
    await settle();

    expect(captureImmediate).toHaveBeenCalledTimes(1);
    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: ARTIFACT_STATUS_CHANGED_EVENT,
      properties: {
        organizationId: "org-1",
        surface: ArtifactStatusEditSurface.Bulk,
        result: ArtifactStatusCommitResult.Committed,
        from: "DRAFT",
        to: "IN_REVIEW",
        artifactCount: 3,
      },
    });
  });

  it("AWAITS the real send instead of the queue-and-forget capture", async () => {
    // `capture()` returns void and only enqueues, so awaiting it resolves at
    // once and a serverless function may freeze with the event undelivered.
    // Swapping this module back to `capture` fails here.
    captureArtifactStatusChangeAnalytics(BASE);
    await settle();

    expect(capture).not.toHaveBeenCalled();
    expect(captureImmediate).toHaveBeenCalledTimes(1);
  });

  it("schedules the send OFF the response path", () => {
    captureArtifactStatusChangeAnalytics(BASE);

    // One promise handed to waitUntil, and the emit has not been awaited by the
    // caller, the function returned before the send settled.
    expect(scheduled).toHaveLength(1);
  });

  it("carries a null origin, which says the artifact held NO status", async () => {
    captureArtifactStatusChangeAnalytics({ ...BASE, from: null });
    await settle();

    expect(captureImmediate.mock.calls[0][0].properties.from).toBeNull();
  });

  it("OMITS the origin rather than nulling it when the commit was mixed", async () => {
    captureArtifactStatusChangeAnalytics({ ...BASE, from: undefined });
    await settle();

    const { properties } = captureImmediate.mock.calls[0][0];
    // Absent, not null: null already claims "held no status", and a mixed bulk
    // commit reported that way corrupts every transition funnel.
    expect("from" in properties).toBe(false);
  });

  it("swallows a delivery failure and logs it, never failing the write", async () => {
    captureImmediate.mockRejectedValue(new Error("posthog down"));

    expect(() => captureArtifactStatusChangeAnalytics(BASE)).not.toThrow();
    await settle();

    expect(logError).toHaveBeenCalledTimes(1);
    expect(logError.mock.calls[0][0]).toContain("artifact status change");
  });
});
