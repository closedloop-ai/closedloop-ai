import {
  ArtifactFieldEditField,
  ArtifactFieldEditOutcome,
} from "@repo/api/src/types/artifact-field-edit-receipt";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ArtifactCustomFieldValueErrorKind } from "./artifact-custom-field-value-contract";
import { InvalidReferenceTargetError } from "./reference-targets";

const mocks = vi.hoisted(() => ({
  findFirst: vi.fn(),
  queryRaw: vi.fn(),
  setValue: vi.fn(),
  clearValue: vi.fn(),
  captureAnalytics: vi.fn(),
}));

const tx = {
  $queryRaw: mocks.queryRaw,
  customFieldValue: { findFirst: mocks.findFirst },
};

vi.mock("@repo/database", () => ({
  withDb: Object.assign(vi.fn(), {
    tx: vi.fn((callback: (client: typeof tx) => unknown) => callback(tx)),
  }),
}));

vi.mock("./values-service", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./values-service")>();
  return {
    ...actual,
    customFieldValuesService: {
      setValueForEntityInTransaction: mocks.setValue,
      clearValueInTransaction: mocks.clearValue,
    },
  };
});

vi.mock("@/lib/artifact-field-edit-analytics", () => ({
  captureArtifactFieldEditAnalytics: mocks.captureAnalytics,
}));

import { artifactCustomFieldValueService } from "./artifact-custom-field-value-service";

const BASE = {
  fieldId: "field-1",
  entityType: CustomFieldEntityType.Document,
  entityId: "document-1",
  organizationId: "org-1",
  context: { actor: { userId: "user-1", authMethod: "session" as const } },
};

beforeEach(() => {
  vi.clearAllMocks();
  mocks.queryRaw.mockResolvedValue([{ id: BASE.entityId }]);
  mocks.setValue.mockResolvedValue({ ok: true, value: { id: "value-1" } });
  mocks.clearValue.mockResolvedValue(1);
});

describe("artifact custom-field value analytics", () => {
  it("classifies a changed dynamic value without its field id or raw value", async () => {
    mocks.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ textValue: "secret" });

    await artifactCustomFieldValueService.set({ ...BASE, rawValue: "secret" });

    expect(mocks.captureAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.CustomField,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      before: null,
      after: "present",
      provenance: undefined,
    });
    const analyticsInput = mocks.captureAnalytics.mock.calls[0][0];
    expect(Object.keys(analyticsInput).sort()).toEqual([
      "after",
      "artifactCount",
      "before",
      "field",
      "organizationId",
      "provenance",
      "result",
      "userId",
    ]);
    expect(JSON.stringify(analyticsInput)).not.toContain("field-1");
    expect(JSON.stringify(analyticsInput)).not.toContain("secret");
  });

  it("reports no-change for a value-preserving retry", async () => {
    const fingerprint = { textValue: "same" };
    mocks.findFirst.mockResolvedValue(fingerprint);

    await artifactCustomFieldValueService.set({ ...BASE, rawValue: "same" });

    expect(mocks.captureAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({
        artifactCount: 1,
        result: ArtifactFieldEditOutcome.NoChange,
      })
    );
  });

  it("locks before reading and classifies a successful clear from delete count", async () => {
    mocks.findFirst.mockResolvedValueOnce({ textValue: "secret" });

    await artifactCustomFieldValueService.clear(BASE);

    expect(mocks.queryRaw.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.findFirst.mock.invocationCallOrder[0]
    );
    expect(mocks.captureAnalytics).toHaveBeenCalledWith({
      organizationId: "org-1",
      userId: "user-1",
      field: ArtifactFieldEditField.CustomField,
      result: ArtifactFieldEditOutcome.Committed,
      artifactCount: 1,
      before: "present",
      after: null,
      provenance: undefined,
    });
  });

  it("classifies a concurrent clear as no-change from deleteMany count", async () => {
    mocks.findFirst.mockResolvedValueOnce({ textValue: "secret" });
    mocks.clearValue.mockResolvedValueOnce(0);

    await artifactCustomFieldValueService.clear(BASE);

    expect(mocks.captureAnalytics).toHaveBeenCalledWith(
      expect.objectContaining({ result: ArtifactFieldEditOutcome.NoChange })
    );
  });

  it("maps a reference-target race only after the transaction rejects", async () => {
    mocks.findFirst.mockResolvedValueOnce(null);
    mocks.setValue.mockRejectedValueOnce(
      new InvalidReferenceTargetError("Reference target no longer exists")
    );

    await expect(
      artifactCustomFieldValueService.set({ ...BASE, rawValue: "target-1" })
    ).resolves.toEqual({
      ok: false,
      error: {
        kind: ArtifactCustomFieldValueErrorKind.InvalidValue,
        message: "Reference target no longer exists",
      },
    });
    expect(mocks.captureAnalytics).not.toHaveBeenCalled();
  });
});

describe("ISS-12552 artifact custom-field write outcome", () => {
  it("reports whether a set moved the stored value", async () => {
    mocks.findFirst
      .mockResolvedValueOnce({ textValue: "before" })
      .mockResolvedValueOnce({ textValue: "after" })
      .mockResolvedValueOnce({ textValue: "same" })
      .mockResolvedValueOnce({ textValue: "same" });

    const moved = await artifactCustomFieldValueService.set({
      ...BASE,
      rawValue: "after",
    });
    const unmoved = await artifactCustomFieldValueService.set({
      ...BASE,
      rawValue: "same",
    });

    expect([moved, unmoved]).toEqual([
      { ok: true, value: { value: { id: "value-1" }, changed: true } },
      { ok: true, value: { value: { id: "value-1" }, changed: false } },
    ]);
  });

  it("reports whether a clear removed a value", async () => {
    mocks.clearValue.mockResolvedValueOnce(1).mockResolvedValueOnce(0);

    const removed = await artifactCustomFieldValueService.clear(BASE);
    const absent = await artifactCustomFieldValueService.clear(BASE);

    expect([removed, absent]).toEqual([{ changed: true }, { changed: false }]);
  });

  it("hands the analytics event to the caller that owns the transaction", async () => {
    const deferred: (() => void)[] = [];
    mocks.findFirst.mockResolvedValueOnce(null);

    await artifactCustomFieldValueService.clear({
      ...BASE,
      context: {
        ...BASE.context,
        deferEffect: (effect) => deferred.push(effect),
      },
    });

    expect(mocks.captureAnalytics).not.toHaveBeenCalled();
    for (const effect of deferred) {
      effect();
    }
    expect(mocks.captureAnalytics).toHaveBeenCalledTimes(1);
  });
});
