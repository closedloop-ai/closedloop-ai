import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { AuditAction } from "@repo/api/src/types/audit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const logError = vi.hoisted(() => vi.fn());
const captureFieldEditAnalytics = vi.hoisted(() => vi.fn());

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn() },
}));

vi.mock("../artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: captureFieldEditAnalytics,
}));

import {
  ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
  ArtifactActivityCaptureStage,
  clearArtifactActivityCaptureFailureThrottle,
  reportArtifactActivityCaptureFailure,
} from "./artifact-activity-capture-telemetry";
import {
  AUDIT_OUTBOX_ENQUEUE_FAILED_EVENT,
  clearAuditOutboxEnqueueFailureThrottle,
  reportAuditOutboxEnqueueFailure,
} from "./audit-outbox-enqueue-telemetry";

beforeEach(() => {
  logError.mockReset();
  captureFieldEditAnalytics.mockReset();
  clearArtifactActivityCaptureFailureThrottle();
  clearAuditOutboxEnqueueFailureThrottle();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("reportArtifactActivityCaptureFailure", () => {
  it("pins the capture-failure event names consumed by infrastructure", () => {
    // example-infrastructure/_envcommon/datadog-capture-failures.hcl filters these literals.
    expect(ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT).toBe(
      "artifact_activity_capture_failed"
    );
    expect(AUDIT_OUTBOX_ENQUEUE_FAILED_EVENT).toBe(
      "audit_outbox_enqueue_failed"
    );
  });

  it("pins infrastructure-owned metric input names and scalar shapes", () => {
    // example-infrastructure/_envcommon/datadog-capture-failures.hcl filters and
    // groups on these literals, so this producer contract must stay exact.
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.SingleUpdate,
      organizationId: "org-1",
      field: ArtifactFieldEditField.Status,
      error: new Error("receipt insert failed"),
    });
    reportAuditOutboxEnqueueFailure({
      organizationId: "org-1",
      action: AuditAction.ProjectStatusChanged,
      error: new Error("outbox insert failed"),
    });

    const activityDetails = logError.mock.calls[0][1];
    const auditDetails = logError.mock.calls[1][1];
    expect({
      event: logError.mock.calls[0][0],
      occurrences: activityDetails.occurrences,
      stage: activityDetails.stage,
    }).toEqual({
      event: "artifact_activity_capture_failed",
      occurrences: 1,
      stage: "single_update",
    });
    expect({
      action: auditDetails.action,
      event: logError.mock.calls[1][0],
      occurrences: auditDetails.occurrences,
    }).toEqual({
      action: "project.status_changed",
      event: "audit_outbox_enqueue_failed",
      occurrences: 1,
    });
  });

  it("preserves lost-entry weights through audit throttle rollups", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-20T00:00:00.000Z"));
    const failure = {
      organizationId: "org-1",
      action: AuditAction.ProjectStatusChanged,
      error: new Error("outbox insert failed"),
    } as const;

    reportAuditOutboxEnqueueFailure({ ...failure, count: 4 });
    reportAuditOutboxEnqueueFailure({ ...failure, count: 6 });
    vi.setSystemTime(new Date("2026-10-20T00:01:30.000Z"));
    reportAuditOutboxEnqueueFailure({ ...failure, count: 2 });

    expect(
      logError.mock.calls.map(([, details]) => details.occurrences)
    ).toEqual([4, 6, 2]);
    expect(logError.mock.calls[1][1]).toMatchObject({
      action: AuditAction.ProjectStatusChanged,
      occurrences: 6,
      rollupCause: "window",
    });
  });

  it("emits the monitored rollback event with optional field and surface", () => {
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.SingleUpdate,
      organizationId: "org-1",
      artifactId: "artifact-1",
      field: ArtifactFieldEditField.Priority,
      surface: ArtifactStatusEditSurface.InlineCell,
      error: new Error("receipt insert failed"),
    });

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.SingleUpdate,
        organizationId: "org-1",
        artifactId: "artifact-1",
        field: ArtifactFieldEditField.Priority,
        surface: ArtifactStatusEditSurface.InlineCell,
        result: ArtifactFieldEditOutcome.RolledBack,
        occurrences: 1,
      })
    );
  });

  it("preserves omission when field and surface are unknown", () => {
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.BatchStatus,
      organizationId: "org-1",
      rolledBackReceiptCount: 3,
      error: new Error("receipt insert failed"),
    });

    const details = logError.mock.calls[0][1];
    expect(details).toMatchObject({
      stage: ArtifactActivityCaptureStage.BatchStatus,
      organizationId: "org-1",
      count: 3,
      rolledBackReceiptCount: 3,
      result: ArtifactFieldEditOutcome.RolledBack,
    });
    expect(details).not.toHaveProperty("field");
    expect(details).not.toHaveProperty("surface");
  });

  it("keeps the throttled rollup classified as rolled back", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-19T00:00:00.000Z"));
    const failure = {
      stage: ArtifactActivityCaptureStage.BatchPriority,
      organizationId: "org-1",
      rolledBackReceiptCount: 2,
      error: new Error("receipt insert failed"),
    } as const;

    reportArtifactActivityCaptureFailure(failure);
    reportArtifactActivityCaptureFailure(failure);
    vi.setSystemTime(new Date("2026-10-19T00:01:30.000Z"));
    reportArtifactActivityCaptureFailure(failure);

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.BatchPriority,
        result: ArtifactFieldEditOutcome.RolledBack,
        occurrences: 1,
      })
    );
    const rollup = logError.mock.calls.find(
      ([, details]) => details.rollupCause === "window"
    );
    expect(rollup?.[0]).toBe(ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT);
    expect(rollup?.[1]).toEqual(
      expect.objectContaining({
        stage: ArtifactActivityCaptureStage.BatchPriority,
        result: ArtifactFieldEditOutcome.RolledBack,
        occurrences: 1,
      })
    );
  });

  it("keeps field and surface as independent throttle dimensions", () => {
    const base = {
      stage: ArtifactActivityCaptureStage.SingleUpdate,
      organizationId: "org-1",
      error: new Error("receipt insert failed"),
    } as const;

    reportArtifactActivityCaptureFailure({
      ...base,
      field: ArtifactFieldEditField.Priority,
      surface: ArtifactStatusEditSurface.Detail,
    });
    reportArtifactActivityCaptureFailure({
      ...base,
      field: ArtifactFieldEditField.Status,
      surface: ArtifactStatusEditSurface.Detail,
    });
    reportArtifactActivityCaptureFailure({
      ...base,
      field: ArtifactFieldEditField.Priority,
      surface: ArtifactStatusEditSurface.InlineCell,
    });

    expect(logError).toHaveBeenCalledTimes(3);
  });

  it("reports the monitored failure even when rollback analytics throws", () => {
    captureFieldEditAnalytics.mockImplementation(() => {
      throw new Error("analytics unavailable");
    });

    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.BatchStatus,
      organizationId: "org-1",
      field: ArtifactFieldEditField.Status,
      error: new Error("receipt insert failed"),
    });

    expect(logError).toHaveBeenCalledWith(
      ARTIFACT_ACTIVITY_CAPTURE_FAILED_EVENT,
      expect.objectContaining({ field: ArtifactFieldEditField.Status })
    );
  });

  it("classifies grouped and undo rollback lineage without exposing ids", () => {
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.BatchPriority,
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Priority,
      commitGroupId: "private-group-id",
      undoOfCommitGroupId: "private-forward-id",
      error: new Error("receipt insert failed"),
    });

    expect(captureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.Priority,
      result: ArtifactFieldEditOutcome.RolledBack,
      commitGroupId: "private-group-id",
      undoOfCommitGroupId: "private-forward-id",
    });
    const logged = JSON.stringify(logError.mock.calls);
    expect(logged).not.toContain("private-group-id");
    expect(logged).not.toContain("private-forward-id");
  });

  it("uses system identity only when the failure has no acting user", () => {
    reportArtifactActivityCaptureFailure({
      stage: ArtifactActivityCaptureStage.BatchStatus,
      organizationId: "org-system",
      field: ArtifactFieldEditField.Status,
      error: new Error("receipt insert failed"),
    });

    expect(captureFieldEditAnalytics).toHaveBeenCalledWith({
      organizationId: "org-system",
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.RolledBack,
    });
  });
});
