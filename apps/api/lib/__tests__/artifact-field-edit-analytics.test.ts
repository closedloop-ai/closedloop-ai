import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
  ArtifactFieldEditValueClassification,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EmissionRollupCause } from "../observability/fixed-window-emission-throttle";

const captureImmediate = vi.hoisted(() => vi.fn());
const scheduled = vi.hoisted(() => [] as Promise<unknown>[]);
const logError = vi.hoisted(() => vi.fn());

vi.mock("@repo/analytics/node", () => ({
  nodeAnalytics: { captureImmediate },
}));

vi.mock("@vercel/functions", () => ({
  waitUntil: vi.fn((promise: Promise<unknown>) => {
    scheduled.push(Promise.resolve(promise).catch(() => undefined));
  }),
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: logError, info: vi.fn(), warn: vi.fn() },
}));

import {
  ARTIFACT_FIELD_EDIT_RESULT_EVENT,
  ArtifactFieldEditLineage,
  captureArtifactFieldEditAnalytics,
  emitArtifactFieldEditAnalytics,
} from "../artifact-field-edit-analytics";
import { createArtifactFieldEditAnalyticsContext } from "../artifact-field-edit-analytics-context";

const BASE = {
  organizationId: "org-1",
  userId: "user-1",
  field: ArtifactFieldEditField.Status,
  result: ArtifactFieldEditOutcome.Committed,
  artifactCount: 1,
} as const;

beforeEach(() => {
  scheduled.length = 0;
  captureImmediate.mockReset().mockResolvedValue(undefined);
  logError.mockReset();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("emitArtifactFieldEditAnalytics", () => {
  it("emits the exact committed event under the editing user", async () => {
    await emitArtifactFieldEditAnalytics({
      ...BASE,
      surface: ArtifactStatusEditSurface.Detail,
      before: "DRAFT",
      after: "IN_REVIEW",
    });

    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: ARTIFACT_FIELD_EDIT_RESULT_EVENT,
      properties: {
        organizationId: "org-1",
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
        artifactCount: 1,
        occurrences: 1,
        lineage: ArtifactFieldEditLineage.Single,
        surface: ArtifactStatusEditSurface.Detail,
        fromValueClassification:
          ArtifactFieldEditValueClassification.Enumerated,
        toValueClassification: ArtifactFieldEditValueClassification.Enumerated,
      },
    });
  });

  it.each([
    ArtifactFieldEditOutcome.NoChange,
    ArtifactFieldEditOutcome.ValidationFailed,
    ArtifactFieldEditOutcome.Conflict,
    ArtifactFieldEditOutcome.RolledBack,
  ])("emits %s without fabricated provenance", async (result) => {
    await emitArtifactFieldEditAnalytics({ ...BASE, result, artifactCount: 0 });

    expect(captureImmediate).toHaveBeenCalledWith({
      distinctId: "user-1",
      event: ARTIFACT_FIELD_EDIT_RESULT_EVENT,
      properties: {
        organizationId: "org-1",
        field: ArtifactFieldEditField.Status,
        result,
        occurrences: 1,
        lineage: ArtifactFieldEditLineage.Single,
      },
    });
  });

  it("takes surface and group lineage from canonical provenance", async () => {
    await emitArtifactFieldEditAnalytics({
      ...BASE,
      provenance: {
        surface: ArtifactStatusEditSurface.Board,
        commitGroupId: "private-group",
      },
    });

    const emission = captureImmediate.mock.calls[0][0];
    expect(emission.properties).toMatchObject({
      lineage: ArtifactFieldEditLineage.Grouped,
      surface: ArtifactStatusEditSurface.Board,
    });
    expect(JSON.stringify(emission)).not.toContain("private-group");
  });

  it("classifies undo lineage without exposing either group id", async () => {
    await emitArtifactFieldEditAnalytics({
      ...BASE,
      commitGroupId: "private-commit",
      undoOfCommitGroupId: "private-forward",
    });

    const emission = captureImmediate.mock.calls[0][0];
    expect(emission.properties.lineage).toBe(ArtifactFieldEditLineage.Undo);
    expect(JSON.stringify(emission)).not.toContain("private-commit");
    expect(JSON.stringify(emission)).not.toContain("private-forward");
  });

  it.each([
    [ArtifactFieldEditField.Title, "private title"],
    [ArtifactFieldEditField.Name, "private session name"],
  ] as const)("withholds raw %s content", async (field, privateValue) => {
    await emitArtifactFieldEditAnalytics({
      ...BASE,
      field,
      before: `old ${privateValue}`,
      after: privateValue,
    });

    const emission = captureImmediate.mock.calls[0][0];
    expect(emission.properties).toMatchObject({
      fromValueClassification: ArtifactFieldEditValueClassification.Content,
      toValueClassification: ArtifactFieldEditValueClassification.Content,
    });
    expect(JSON.stringify(emission)).not.toContain(privateValue);
  });

  it("swallows delivery failure with bounded diagnostics", async () => {
    captureImmediate.mockRejectedValue(new Error("posthog down"));

    await expect(emitArtifactFieldEditAnalytics(BASE)).resolves.toBeUndefined();
    expect(logError).toHaveBeenCalledWith(
      "Failed to capture artifact field edit analytics",
      expect.objectContaining({
        organizationId: "org-1",
        field: ArtifactFieldEditField.Status,
        result: ArtifactFieldEditOutcome.Committed,
      })
    );
  });

  it("bounds a burst and emits its suppressed-count rollup", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2030-01-01T00:00:00.000Z"));
    const burst = { ...BASE, organizationId: "org-burst" };

    for (let index = 0; index < 5; index += 1) {
      captureArtifactFieldEditAnalytics(burst);
    }
    expect(scheduled).toHaveLength(1);

    vi.setSystemTime(new Date("2030-01-01T00:01:30.000Z"));
    captureArtifactFieldEditAnalytics(burst);
    await Promise.all(scheduled);

    expect(captureImmediate).toHaveBeenCalledTimes(3);
    expect(captureImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        properties: expect.objectContaining({
          occurrences: 4,
          rollupCause: EmissionRollupCause.Expiry,
        }),
      })
    );
  });

  it("bounds delivery-failure diagnostics and rolls up suppressed failures", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2031-01-01T00:00:00.000Z"));
    captureImmediate.mockRejectedValue(new Error("posthog down"));
    const burst = { ...BASE, organizationId: "org-failure-burst" };

    for (let index = 0; index < 5; index += 1) {
      await emitArtifactFieldEditAnalytics(burst);
    }
    expect(logError).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2031-01-01T00:01:30.000Z"));
    await emitArtifactFieldEditAnalytics(burst);

    expect(logError).toHaveBeenCalledTimes(3);
    expect(logError).toHaveBeenCalledWith(
      "Failed to capture artifact field edit analytics",
      expect.objectContaining({
        occurrences: 4,
        rollupCause: EmissionRollupCause.Expiry,
      })
    );
  });
});

describe("captureArtifactFieldEditAnalytics", () => {
  it("schedules the send through waitUntil", async () => {
    captureArtifactFieldEditAnalytics(BASE);

    expect(scheduled).toHaveLength(1);
    await Promise.all(scheduled);
    expect(captureImmediate).toHaveBeenCalledTimes(1);
  });

  it("binds one trusted provenance decision to receipt and analytics", async () => {
    const context = createArtifactFieldEditAnalyticsContext({
      organizationId: "org-context",
      userId: "user-context",
      authMethod: "session",
      surface: ArtifactStatusEditSurface.Detail,
    });

    expect(context.receiptContext).toEqual({
      provenance: { surface: ArtifactStatusEditSurface.Detail },
    });
    context.capture({
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
    });
    await Promise.all(scheduled);

    expect(captureImmediate).toHaveBeenCalledWith(
      expect.objectContaining({
        distinctId: "user-context",
        properties: expect.objectContaining({
          organizationId: "org-context",
          surface: ArtifactStatusEditSurface.Detail,
        }),
      })
    );
  });

  it("drops an API-key surface from both bound sinks", async () => {
    const context = createArtifactFieldEditAnalyticsContext({
      organizationId: "org-api-key-context",
      userId: "api-key-user",
      authMethod: "api_key",
      surface: ArtifactStatusEditSurface.Detail,
    });

    expect(context.receiptContext).toBeUndefined();
    context.capture({
      field: ArtifactFieldEditField.Status,
      result: ArtifactFieldEditOutcome.Committed,
    });
    await Promise.all(scheduled);

    expect(captureImmediate.mock.calls[0][0].properties).not.toHaveProperty(
      "surface"
    );
  });
});
