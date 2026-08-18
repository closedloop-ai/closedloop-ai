/**
 * Unit tests for the customFieldValuesService SETTINGS lane —
 * attachField (including the Project → feature-document cascade), detachField,
 * and listSettings.
 *
 * The value lane is covered in values-service.test.ts; both drive the shared db
 * harness in `@/__tests__/support/custom-fields/values-service.test-fixtures`.
 */
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  type Mock,
  vi,
} from "vitest";

vi.mock("@repo/database", () => ({
  withDb: vi.fn(),
  Prisma: {
    TransactionIsolationLevel: {
      ReadUncommitted: "ReadUncommitted",
      ReadCommitted: "ReadCommitted",
      RepeatableRead: "RepeatableRead",
      Serializable: "Serializable",
    },
  },
  ArtifactType: {
    DOCUMENT: "DOCUMENT",
    BRANCH: "BRANCH",
    DEPLOYMENT: "DEPLOYMENT",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, Prisma, withDb } from "@repo/database";
import {
  buildSettingFieldRelation,
  type DbMocks,
  installDb,
  TEST_ENTITY_ID,
  TEST_FIELD_ID,
  TEST_ORG_ID,
} from "@/__tests__/support/custom-fields/values-service.test-fixtures";
import {
  ATTACH_TX_MAX_ATTEMPTS,
  CASCADE_CHILD_BATCH_SIZE,
  CASCADE_TX_TIMEOUT_MS,
  customFieldValuesService,
  EntityNotFoundError,
  FieldNotFoundError,
} from "../values-service";

const mockWithDb = withDb as unknown as Mock;
const TEST_PROJECT_ID = "project-1";

/** Installs the shared db harness against this file's mocked `withDb`. */
function install(overrides: Partial<DbMocks> = {}): DbMocks {
  return installDb(mockWithDb, overrides);
}

/** Builds a persisted CustomFieldSetting row with its customField relation. */
function buildSettingRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "setting-1",
    customFieldId: TEST_FIELD_ID,
    organizationId: TEST_ORG_ID,
    entityType: CustomFieldEntityType.Document,
    entityId: TEST_ENTITY_ID,
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date("2024-01-01"),
    customField: buildSettingFieldRelation(),
    ...overrides,
  };
}

/**
 * Installs a `withDb.tx` double for the attach path and returns the tx mocks.
 * `pages` are the successive artifact pages the paged cascade scan will read;
 * every call past the last page drains to an empty page.
 */
function installPagedAttachTx(
  created: Record<string, unknown>,
  pages: { id: string }[][]
) {
  const create = vi.fn().mockResolvedValue(created);
  const createMany = vi
    .fn()
    .mockImplementation((args: { data: unknown[] }) => ({
      count: args.data.length,
    }));
  let page = 0;
  const artifactFindMany = vi.fn().mockImplementation(() => {
    const current = pages[page] ?? [];
    page += 1;
    return Promise.resolve(current);
  });

  const tx = vi.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({
      customFieldSetting: { create, createMany },
      artifact: { findMany: artifactFindMany },
    })
  );
  (withDb as unknown as { tx: Mock }).tx = tx;

  return { create, createMany, artifactFindMany, tx };
}

/** Single-page shorthand for the common cascade cases. */
function installAttachTx(
  created: Record<string, unknown>,
  children: { id: string }[]
) {
  return installPagedAttachTx(created, [children]);
}

/** Builds `count` distinct artifact rows with zero-padded, ascending ids. */
function buildChildPage(count: number, prefix: string): { id: string }[] {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `${prefix}-${String(index).padStart(5, "0")}`,
  }));
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// attachField
// ---------------------------------------------------------------------------

describe("customFieldValuesService.attachField", () => {
  it("rejects a field from another org before opening the transaction", async () => {
    install({ customFieldFindFirst: vi.fn().mockResolvedValue(null) });
    const tx = vi.fn();
    (withDb as unknown as { tx: Mock }).tx = tx;

    await expect(
      customFieldValuesService.attachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        { customFieldId: TEST_FIELD_ID }
      )
    ).rejects.toThrow(FieldNotFoundError);

    expect(tx).not.toHaveBeenCalled();
  });

  it("rejects an entity from another org before opening the transaction", async () => {
    install({ artifactFindFirst: vi.fn().mockResolvedValue(null) });
    const tx = vi.fn();
    (withDb as unknown as { tx: Mock }).tx = tx;

    await expect(
      customFieldValuesService.attachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID,
        { customFieldId: TEST_FIELD_ID }
      )
    ).rejects.toThrow(EntityNotFoundError);

    expect(tx).not.toHaveBeenCalled();
  });

  it("defaults the setting flags and does not cascade for a non-Project entity", async () => {
    install();
    const { create, artifactFindMany } = installAttachTx(buildSettingRow(), []);

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    expect(create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          organizationId: TEST_ORG_ID,
          isImportant: false,
          isRequired: false,
          sortOrder: 0,
        }),
      })
    );
    // The cascade is Project-only — a Document attach must not scan for children.
    expect(artifactFindMany).not.toHaveBeenCalled();
  });

  it("opens the attach transaction at RepeatableRead with a raised timeout", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      [{ id: "doc-feat-1" }]
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // One snapshot across every keyset page, so a child relinked in below the
    // cursor cannot be skipped by the pages that follow; and a window wide
    // enough that the serial page loop does not P2028 on a large project.
    expect((withDb as unknown as { tx: Mock }).tx).toHaveBeenCalledWith(
      expect.any(Function),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: CASCADE_TX_TIMEOUT_MS,
      }
    );
  });

  it("cascades to child feature documents with skipDuplicates when attaching to a Project", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { createMany, artifactFindMany } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      [{ id: "doc-feat-1" }, { id: "doc-feat-2" }]
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // The stub answers with the same children whatever the filter, so the
    // org scope and the feature-subtype narrowing are only proven here.
    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          projectId: TEST_PROJECT_ID,
          organizationId: TEST_ORG_ID,
          type: ArtifactType.DOCUMENT,
          subtype: ArtifactSubtype.FEATURE,
        },
      })
    );

    expect(createMany).toHaveBeenCalledOnce();
    expect(createMany).toHaveBeenCalledWith(
      expect.objectContaining({ skipDuplicates: true })
    );

    const rows = createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(2);
    expect(
      rows.every(
        (row: { entityType: string }) =>
          row.entityType === CustomFieldEntityType.Document
      )
    ).toBe(true);
    expect(rows.map((row: { entityId: string }) => row.entityId)).toEqual(
      expect.arrayContaining(["doc-feat-1", "doc-feat-2"])
    );
  });

  it("does not call createMany when the Project has no child features", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { createMany } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      []
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    expect(createMany).not.toHaveBeenCalled();
  });

  it("carries caller-supplied flags into the cascaded child settings", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { createMany } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
        isImportant: true,
        isRequired: true,
        sortOrder: 7,
      }),
      [{ id: "doc-1" }]
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      {
        customFieldId: TEST_FIELD_ID,
        isImportant: true,
        isRequired: true,
        sortOrder: 7,
      }
    );

    expect(createMany.mock.calls[0][0].data[0]).toMatchObject({
      isImportant: true,
      isRequired: true,
      sortOrder: 7,
      organizationId: TEST_ORG_ID,
      entityType: CustomFieldEntityType.Document,
      entityId: "doc-1",
    });
  });

  it("bounds the child scan and stops paging on a short page", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { artifactFindMany } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      [{ id: "doc-feat-1" }]
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    expect(artifactFindMany).toHaveBeenCalledOnce();
    expect(artifactFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        take: CASCADE_CHILD_BATCH_SIZE,
        orderBy: { id: "asc" },
      })
    );
    // The first page is unanchored — a keyset bound here would skip a real row.
    expect(artifactFindMany.mock.calls[0][0].where).not.toHaveProperty("id");
  });

  it("pages the child scan and chunks the writes past one batch", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const firstPage = buildChildPage(CASCADE_CHILD_BATCH_SIZE, "page-a");
    const secondPage = buildChildPage(3, "page-b");
    const { createMany, artifactFindMany } = installPagedAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      [firstPage, secondPage]
    );

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // A full page must be followed by another scan anchored past its last id,
    // and a short page must end the cascade without a third scan.
    expect(artifactFindMany).toHaveBeenCalledTimes(2);
    expect(artifactFindMany.mock.calls[1][0]).toMatchObject({
      take: CASCADE_CHILD_BATCH_SIZE,
      where: {
        projectId: TEST_PROJECT_ID,
        organizationId: TEST_ORG_ID,
        type: ArtifactType.DOCUMENT,
        subtype: ArtifactSubtype.FEATURE,
        id: { gt: firstPage.at(-1)?.id },
      },
    });

    // Every insert stays bounded — an unchunked createMany would carry all
    // CASCADE_CHILD_BATCH_SIZE + 3 rows in one statement.
    expect(createMany).toHaveBeenCalledTimes(2);
    const writtenBatches: { entityId: string }[][] = createMany.mock.calls.map(
      ([args]) => args.data
    );
    expect(writtenBatches.map((batch) => batch.length)).toEqual([
      CASCADE_CHILD_BATCH_SIZE,
      3,
    ]);

    const writtenEntityIds = writtenBatches.flatMap((batch) =>
      batch.map((row) => row.entityId)
    );
    expect(writtenEntityIds).toEqual(
      [...firstPage, ...secondPage].map((doc) => doc.id)
    );
  });

  it("retries the attach transaction on a serialization failure", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { tx, createMany } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      [{ id: "doc-feat-1" }]
    );
    // RepeatableRead promotes the cascade's ON CONFLICT DO NOTHING from a
    // silent skip to a 40001 abort, so the first attempt rolls back whole.
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    const runTx = tx.getMockImplementation() as (
      callback: (tx: unknown) => unknown
    ) => unknown;
    tx.mockReset();
    tx.mockImplementationOnce(() =>
      Promise.reject(conflict)
    ).mockImplementation(runTx);

    const setting = await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      TEST_PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    expect(tx).toHaveBeenCalledTimes(2);
    // The retry ran the cascade, so the second attempt did the real work.
    expect(createMany).toHaveBeenCalledOnce();
    expect(setting.entityId).toBe(TEST_PROJECT_ID);
  });

  it("gives up after the attempt cap when the conflict never clears", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { tx } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      []
    );
    const conflict = Object.assign(new Error("write conflict"), {
      code: "P2034",
    });
    tx.mockReset();
    tx.mockImplementation(() => Promise.reject(conflict));

    // Sustained contention must surface the conflict, not spin forever.
    await expect(
      customFieldValuesService.attachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Project,
        TEST_PROJECT_ID,
        TEST_ORG_ID,
        { customFieldId: TEST_FIELD_ID }
      )
    ).rejects.toBe(conflict);

    expect(tx).toHaveBeenCalledTimes(ATTACH_TX_MAX_ATTEMPTS);
  });

  it("does not retry a failure that is not a serialization conflict", async () => {
    install({
      projectFindFirst: vi.fn().mockResolvedValue({ id: TEST_PROJECT_ID }),
    });
    const { tx } = installAttachTx(
      buildSettingRow({
        entityType: CustomFieldEntityType.Project,
        entityId: TEST_PROJECT_ID,
      }),
      []
    );
    const duplicate = Object.assign(new Error("unique violation"), {
      code: "P2002",
    });
    tx.mockReset();
    tx.mockImplementation(() => Promise.reject(duplicate));

    await expect(
      customFieldValuesService.attachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Project,
        TEST_PROJECT_ID,
        TEST_ORG_ID,
        { customFieldId: TEST_FIELD_ID }
      )
    ).rejects.toBe(duplicate);

    expect(tx).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// detachField and listSettings
// ---------------------------------------------------------------------------

describe("customFieldValuesService.detachField", () => {
  it("scopes the delete to field, entity, and organization", async () => {
    const mocks = install();

    await customFieldValuesService.detachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(mocks.settingDeleteMany).toHaveBeenCalledWith({
      where: {
        customFieldId: TEST_FIELD_ID,
        entityType: CustomFieldEntityType.Document,
        entityId: TEST_ENTITY_ID,
        organizationId: TEST_ORG_ID,
      },
    });
  });

  it("deletes nothing when the entity belongs to another org", async () => {
    const mocks = install({
      artifactFindFirst: vi.fn().mockResolvedValue(null),
    });

    await expect(
      customFieldValuesService.detachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Document,
        TEST_ENTITY_ID,
        TEST_ORG_ID
      )
    ).rejects.toThrow(EntityNotFoundError);

    expect(mocks.settingDeleteMany).not.toHaveBeenCalled();
  });
});

describe("customFieldValuesService.listSettings", () => {
  it("scopes to the entity and organization and orders by sortOrder", async () => {
    const mocks = install();

    await customFieldValuesService.listSettings(
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(mocks.settingFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          entityType: CustomFieldEntityType.Document,
          entityId: TEST_ENTITY_ID,
          organizationId: TEST_ORG_ID,
        },
        orderBy: { sortOrder: "asc" },
      })
    );
  });

  it("projects the field definition and its options onto each setting", async () => {
    install({
      settingFindMany: vi.fn().mockResolvedValue([buildSettingRow()]),
    });

    const settings = await customFieldValuesService.listSettings(
      CustomFieldEntityType.Document,
      TEST_ENTITY_ID,
      TEST_ORG_ID
    );

    expect(settings).toHaveLength(1);
    expect(settings[0].customField.id).toBe(TEST_FIELD_ID);
    expect(settings[0].customField.enumOptions).toEqual([]);
  });
});
