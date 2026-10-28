import { describe, expect, it } from "vitest";
import { OperationReceiptOutcome } from "./attribution-evidence.ts";
import {
  GRID_PREFERENCE_CONTRACT_VERSION,
  GRID_PREFERENCE_REVISION_MAX,
  GridPreferenceErrorCode,
  GridPreferenceGridKey,
  GridPreferenceKind,
  GridPreferenceReadStatus,
  GridPreferenceResetStatus,
  GridPreferenceScopeKey,
  GridPreferenceWriteStatus,
  projectGridPreferenceScopeKey,
} from "./grid-preferences.ts";
import {
  gridPreferenceReadQuerySchema,
  gridPreferenceResetQuerySchema,
  gridPreferenceResetResponseSchema,
  gridPreferenceRevisionConflictSchema,
  gridPreferenceUpsertRequestEnvelopeSchema,
  gridPreferenceUpsertResponseSchema,
} from "./grid-preferences-schema.ts";

const PARTIAL_SELECTOR_ERROR_RE = /must be provided together/;
const APPROVED_SCOPE_ERROR_RE = /only supported for the branches grid/;

describe("gridPreferenceReadQuerySchema", () => {
  it("distinguishes list reads from full selector reads", () => {
    expect(gridPreferenceReadQuerySchema.parse({})).toEqual({});
    expect(
      gridPreferenceReadQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      })
    ).toEqual({
      selector: {
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      },
    });
  });

  it("rejects partial selectors rather than guessing a default scope", () => {
    expect(() =>
      gridPreferenceReadQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
      })
    ).toThrow(PARTIAL_SELECTOR_ERROR_RE);
  });

  it("rejects reserved scope on the wrong grid", () => {
    expect(() =>
      gridPreferenceReadQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Agents,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Approved,
      })
    ).toThrow(APPROVED_SCOPE_ERROR_RE);
  });

  it("accepts project-scoped Project Artifact selectors only", () => {
    const scopeKey = projectGridPreferenceScopeKey("project-one");

    expect(
      gridPreferenceReadQuerySchema.parse({
        gridKey: GridPreferenceGridKey.ProjectArtifacts,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey,
      })
    ).toEqual({
      selector: {
        gridKey: GridPreferenceGridKey.ProjectArtifacts,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey,
      },
    });
    expect(() =>
      gridPreferenceReadQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey,
      })
    ).toThrow();
  });
});

describe("gridPreferenceUpsertRequestEnvelopeSchema", () => {
  it("preserves absent expectedRevision as omitted, not null", () => {
    const parsed = gridPreferenceUpsertRequestEnvelopeSchema.parse({
      gridKey: GridPreferenceGridKey.Branches,
      preferenceKind: GridPreferenceKind.ViewState,
      scopeKey: GridPreferenceScopeKey.Approved,
      value: { columnOrder: ["name", "status"] },
    });

    expect(Object.hasOwn(parsed, "expectedRevision")).toBe(false);
  });

  it("rejects null expectedRevision and caller-supplied authority fields", () => {
    expect(() =>
      gridPreferenceUpsertRequestEnvelopeSchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        value: {},
        expectedRevision: null,
      })
    ).toThrow();
    expect(() =>
      gridPreferenceUpsertRequestEnvelopeSchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        organizationId: "org-spoofed",
        userId: "user-spoofed",
        value: {},
      })
    ).toThrow();
  });

  it("caps expectedRevision at the PostgreSQL int4 ceiling", () => {
    expect(
      gridPreferenceUpsertRequestEnvelopeSchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        value: {},
        expectedRevision: GRID_PREFERENCE_REVISION_MAX,
      }).expectedRevision
    ).toBe(GRID_PREFERENCE_REVISION_MAX);

    expect(() =>
      gridPreferenceUpsertRequestEnvelopeSchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        value: {},
        expectedRevision: GRID_PREFERENCE_REVISION_MAX + 1,
      })
    ).toThrow();

    expect(
      gridPreferenceResetQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        expectedRevision: String(GRID_PREFERENCE_REVISION_MAX),
      }).expectedRevision
    ).toBe(GRID_PREFERENCE_REVISION_MAX);

    expect(() =>
      gridPreferenceResetQuerySchema.parse({
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
        expectedRevision: String(GRID_PREFERENCE_REVISION_MAX + 1),
      })
    ).toThrow();
  });
});

describe("gridPreferenceRevisionConflictSchema", () => {
  it("requires absent current fields to be omitted when no row exists", () => {
    const parsed = gridPreferenceRevisionConflictSchema.parse({
      code: GridPreferenceErrorCode.StaleRevision,
      selector: {
        gridKey: GridPreferenceGridKey.Sessions,
        preferenceKind: GridPreferenceKind.ViewState,
        scopeKey: GridPreferenceScopeKey.Default,
      },
      expectedRevision: 7,
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    });

    expect(Object.hasOwn(parsed, "current")).toBe(false);
    expect(Object.hasOwn(parsed, "currentRevision")).toBe(false);
  });

  it("rejects null optional conflict fields", () => {
    expect(() =>
      gridPreferenceRevisionConflictSchema.parse({
        code: GridPreferenceErrorCode.StaleRevision,
        selector: {
          gridKey: GridPreferenceGridKey.Sessions,
          preferenceKind: GridPreferenceKind.ViewState,
          scopeKey: GridPreferenceScopeKey.Default,
        },
        expectedRevision: 7,
        currentRevision: null,
        current: null,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
      })
    ).toThrow();
  });

  it("keeps response status names separate from the error code", () => {
    expect(GridPreferenceReadStatus.Missing).toBe("missing");
    expect(GridPreferenceErrorCode.StaleRevision).toBe(
      "grid_preference_stale_revision"
    );
  });
});

describe("grid preference write responses", () => {
  const selector = {
    gridKey: GridPreferenceGridKey.Sessions,
    preferenceKind: GridPreferenceKind.ViewState,
    scopeKey: GridPreferenceScopeKey.Default,
  };
  const operationReceipt = {
    operationId: "clop_01a14224-9b59-77ba-b518-16aaa9880993",
    outcome: OperationReceiptOutcome.Committed,
  };
  const stored = {
    status: GridPreferenceWriteStatus.Stored,
    preference: {
      ...selector,
      value: { columns: [] },
      revision: 3,
      createdAt: "2026-10-22T00:00:00.000Z",
      updatedAt: "2026-10-22T00:00:00.000Z",
      contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
    },
    contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
  };

  it("reads an API-key upsert that carries its operation receipt", () => {
    expect(
      gridPreferenceUpsertResponseSchema.parse({ ...stored, operationReceipt })
        .operationReceipt
    ).toEqual(operationReceipt);
  });

  it("reads an API-key reset that carries its operation receipt", () => {
    expect(
      gridPreferenceResetResponseSchema.parse({
        status: GridPreferenceResetStatus.Deleted,
        selector,
        previousRevision: 3,
        contractVersion: GRID_PREFERENCE_CONTRACT_VERSION,
        operationReceipt,
      }).operationReceipt
    ).toEqual(operationReceipt);
  });

  it("still refuses a key the write contract does not declare", () => {
    expect(
      gridPreferenceUpsertResponseSchema.safeParse({
        ...stored,
        operationReceipt,
        undeclared: true,
      }).success
    ).toBe(false);
  });
});
