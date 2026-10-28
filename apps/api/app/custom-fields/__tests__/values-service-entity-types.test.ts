/**
 * ISS-7209 — SESSION and BRANCH as custom-field entity types.
 *
 * DOCUMENT, SESSION and BRANCH all address the same `artifacts` table by id, so
 * the suite drives `artifact.findFirst` against a real three-row table with
 * Prisma's own optional-filter semantics (`where.type === undefined` matches
 * every row). Dropping the type predicate from `verifyEntityExists` therefore
 * turns the cross-type rejections below red while leaving the accept cases
 * green — which is the point of them.
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
    SESSION: "SESSION",
  },
  ArtifactSubtype: {
    PRD: "PRD",
    IMPLEMENTATION_PLAN: "IMPLEMENTATION_PLAN",
    TEMPLATE: "TEMPLATE",
    FEATURE: "FEATURE",
  },
}));

import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { ArtifactSubtype, ArtifactType, withDb } from "@repo/database";
import {
  buildFieldRow,
  buildSettingFieldRelation,
  type DbMocks,
  installDb,
  TEST_FIELD_ID,
  TEST_ORG_ID,
} from "@/__tests__/support/custom-fields/values-service.test-fixtures";
import { EntityNotFoundError } from "../custom-field-errors";
import { InvalidFieldValueError } from "../utils";
import { customFieldValuesService } from "../values-service";

const mockWithDb = withDb as unknown as Mock;

const DOCUMENT_ID = "artifact-document-1";
const SESSION_ID = "artifact-session-1";
const BRANCH_ID = "artifact-branch-1";
const PROJECT_ID = "project-1";

type ArtifactRow = {
  id: string;
  organizationId: string;
  projectId: string | null;
  type: string;
  subtype: string | null;
};

/** One artifact of each kind, all in the same org and all reachable by id. */
const ARTIFACT_TABLE: ArtifactRow[] = [
  {
    id: DOCUMENT_ID,
    organizationId: TEST_ORG_ID,
    projectId: PROJECT_ID,
    type: ArtifactType.DOCUMENT,
    subtype: ArtifactSubtype.FEATURE,
  },
  {
    id: SESSION_ID,
    organizationId: TEST_ORG_ID,
    projectId: PROJECT_ID,
    type: ArtifactType.SESSION,
    subtype: null,
  },
  {
    id: BRANCH_ID,
    organizationId: TEST_ORG_ID,
    projectId: PROJECT_ID,
    type: ArtifactType.BRANCH,
    subtype: null,
  },
];

type CascadedSetting = { entityId: string; entityType: string };

type ArtifactWhere = {
  id?: string;
  organizationId?: string;
  projectId?: string;
  type?: string;
  subtype?: string;
};

/**
 * Applies a `where` the way Prisma does: a key the caller omitted is not a
 * filter. That is what makes a missing type predicate observable here instead
 * of failing every lookup.
 */
function matchesWhere(row: ArtifactRow, where: ArtifactWhere): boolean {
  return (
    (where.id === undefined || row.id === where.id) &&
    (where.organizationId === undefined ||
      row.organizationId === where.organizationId) &&
    (where.projectId === undefined || row.projectId === where.projectId) &&
    (where.type === undefined || row.type === where.type) &&
    (where.subtype === undefined || row.subtype === where.subtype)
  );
}

/** Installs the shared db harness with `artifact.findFirst` backed by the table. */
function installWithArtifactTable(overrides: Partial<DbMocks> = {}): DbMocks {
  return installDb(mockWithDb, {
    artifactFindFirst: vi.fn(({ where }: { where: ArtifactWhere }) =>
      // `?? null` because that is what Prisma returns on a miss, and the
      // service's own `record !== null` check reads it literally.
      Promise.resolve(
        ARTIFACT_TABLE.find((row) => matchesWhere(row, where)) ?? null
      )
    ),
    customFieldFindFirst: vi
      .fn()
      .mockResolvedValue(buildFieldRow({ fieldType: CustomFieldType.Text })),
    ...overrides,
  });
}

/**
 * Installs a `withDb.tx` double whose cascade scan reads the same artifact
 * table, so which children the cascade covers is decided by the service's own
 * predicate rather than by a canned page.
 */
function installAttachTxOverTable() {
  const create = vi.fn().mockResolvedValue({
    id: "setting-1",
    customFieldId: TEST_FIELD_ID,
    organizationId: TEST_ORG_ID,
    entityType: CustomFieldEntityType.Project,
    entityId: PROJECT_ID,
    isImportant: false,
    isRequired: false,
    sortOrder: 0,
    createdAt: new Date("2024-01-01"),
    customField: buildSettingFieldRelation(),
  });
  const cascadedSettings: CascadedSetting[] = [];
  const createMany = vi
    .fn()
    .mockImplementation((args: { data: CascadedSetting[] }) => {
      cascadedSettings.push(...args.data);
      return { count: args.data.length };
    });
  const artifactFindMany = vi
    .fn()
    .mockImplementation(
      ({ where }: { where: ArtifactWhere & { id?: { gt: string } } }) => {
        const cursor = (where.id as { gt?: string } | undefined)?.gt;
        return Promise.resolve(
          ARTIFACT_TABLE.filter(
            (row) =>
              matchesWhere(row, { ...where, id: undefined }) &&
              (cursor === undefined || row.id > cursor)
          ).map((row) => ({ id: row.id }))
        );
      }
    );

  const tx = vi.fn().mockImplementation((callback: (tx: unknown) => unknown) =>
    callback({
      customFieldSetting: { create, createMany },
      artifact: { findMany: artifactFindMany },
    })
  );
  (withDb as unknown as { tx: Mock }).tx = tx;

  return { create, createMany, artifactFindMany, cascadedSettings };
}

beforeEach(() => {
  vi.clearAllMocks();
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ---------------------------------------------------------------------------
// Cross-type confusion — the load-bearing guard
// ---------------------------------------------------------------------------

describe("verifyEntityExists — cross-type artifact confusion", () => {
  const crossTypeCases = [
    {
      name: "a Session id presented as a DOCUMENT",
      entityType: CustomFieldEntityType.Document,
      entityId: SESSION_ID,
    },
    {
      name: "a Branch id presented as a DOCUMENT",
      entityType: CustomFieldEntityType.Document,
      entityId: BRANCH_ID,
    },
    {
      name: "a Document id presented as a SESSION",
      entityType: CustomFieldEntityType.Session,
      entityId: DOCUMENT_ID,
    },
    {
      name: "a Branch id presented as a SESSION",
      entityType: CustomFieldEntityType.Session,
      entityId: BRANCH_ID,
    },
    {
      name: "a Document id presented as a BRANCH",
      entityType: CustomFieldEntityType.Branch,
      entityId: DOCUMENT_ID,
    },
    {
      name: "a Session id presented as a BRANCH",
      entityType: CustomFieldEntityType.Branch,
      entityId: SESSION_ID,
    },
  ];

  for (const testCase of crossTypeCases) {
    it(`rejects ${testCase.name}`, async () => {
      installWithArtifactTable();

      await expect(
        customFieldValuesService.setValueForEntity(
          TEST_FIELD_ID,
          testCase.entityType,
          testCase.entityId,
          TEST_ORG_ID,
          "some value"
        )
      ).rejects.toThrow(EntityNotFoundError);
    });
  }

  it("rejects a cross-type id on detach before it reaches the delete", async () => {
    const mocks = installWithArtifactTable();

    await expect(
      customFieldValuesService.detachField(
        TEST_FIELD_ID,
        CustomFieldEntityType.Session,
        DOCUMENT_ID,
        TEST_ORG_ID
      )
    ).rejects.toThrow(EntityNotFoundError);

    expect(mocks.settingDeleteMany).not.toHaveBeenCalled();
  });

  it("scopes a value clear by entityType, so a cross-type clear cannot reach another kind's row", async () => {
    const mocks = installWithArtifactTable();

    // `clearValue` deliberately does NOT call verifyEntityExists — it is a
    // keyed deleteMany. What protects it is the entityType IN the WHERE, so
    // that is what this asserts: drop `entityType` from the predicate and a
    // SESSION-scoped clear would delete the DOCUMENT-typed row sharing the id.
    await customFieldValuesService.clearValue(
      TEST_FIELD_ID,
      CustomFieldEntityType.Session,
      DOCUMENT_ID,
      TEST_ORG_ID
    );

    expect(mocks.valueDeleteMany).toHaveBeenCalledWith({
      where: {
        customFieldId: TEST_FIELD_ID,
        entityType: CustomFieldEntityType.Session,
        entityId: DOCUMENT_ID,
        organizationId: TEST_ORG_ID,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// AC-1 — a field can be attached to and valued on a Session and a Branch
// ---------------------------------------------------------------------------

describe("custom fields on SESSION and BRANCH entities", () => {
  const entityCases = [
    { entityType: CustomFieldEntityType.Session, entityId: SESSION_ID },
    { entityType: CustomFieldEntityType.Branch, entityId: BRANCH_ID },
  ];

  for (const { entityType, entityId } of entityCases) {
    it(`accepts a value written against a matching ${entityType} id`, async () => {
      const mocks = installWithArtifactTable();

      await customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        entityType,
        entityId,
        TEST_ORG_ID,
        "shipped"
      );

      expect(mocks.valueUpsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            entityType,
            entityId,
            textValue: "shipped",
            displayValue: "shipped",
          }),
        })
      );
    });

    it(`attaches a field to a ${entityType} without cascading`, async () => {
      installWithArtifactTable();
      const { create, artifactFindMany } = installAttachTxOverTable();

      await customFieldValuesService.attachField(
        TEST_FIELD_ID,
        entityType,
        entityId,
        TEST_ORG_ID,
        { customFieldId: TEST_FIELD_ID }
      );

      expect(create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ entityType, entityId }),
        })
      );
      expect(artifactFindMany).not.toHaveBeenCalled();
    });

    it(`lists settings scoped to the ${entityType} entity type`, async () => {
      const mocks = installWithArtifactTable();

      await customFieldValuesService.listSettings(
        entityType,
        entityId,
        TEST_ORG_ID
      );

      expect(mocks.settingFindMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ entityType, entityId }),
        })
      );
    });
  }
});

// ---------------------------------------------------------------------------
// AC-3 — the project cascade decision for unparented Sessions/Branches
// ---------------------------------------------------------------------------

describe("cascadeProjectFieldToChildren — SESSION and BRANCH are excluded", () => {
  it("cascades a project attach to feature documents only, never to a project's sessions or branches", async () => {
    installWithArtifactTable({
      projectFindFirst: vi.fn().mockResolvedValue({ id: PROJECT_ID }),
    });
    const { cascadedSettings } = installAttachTxOverTable();

    await customFieldValuesService.attachField(
      TEST_FIELD_ID,
      CustomFieldEntityType.Project,
      PROJECT_ID,
      TEST_ORG_ID,
      { customFieldId: TEST_FIELD_ID }
    );

    // The session and the branch in ARTIFACT_TABLE carry this same projectId, so
    // a cascade that stopped discriminating on artifact type would pick them up.
    expect(cascadedSettings).toEqual([
      expect.objectContaining({
        entityId: DOCUMENT_ID,
        entityType: CustomFieldEntityType.Document,
      }),
    ]);
  });
});

// ---------------------------------------------------------------------------
// FEA-4222 (davetho review cid 3884188153) — a value may only be written for
// an entity type the field's own definition declares.
// ---------------------------------------------------------------------------

describe("setValueForEntity — entity applicability", () => {
  it("rejects a Session value for a Document-only field", async () => {
    const mocks = installWithArtifactTable({
      customFieldFindFirst: vi.fn().mockResolvedValue(
        buildFieldRow({
          entityTypes: [CustomFieldEntityType.Document],
          fieldType: CustomFieldType.Text,
        })
      ),
    });

    await expect(
      customFieldValuesService.setValueForEntity(
        TEST_FIELD_ID,
        CustomFieldEntityType.Session,
        SESSION_ID,
        TEST_ORG_ID,
        "shipped"
      )
    ).rejects.toThrow(InvalidFieldValueError);

    // Rejected BEFORE the write, not merely reported after it. A guard that
    // threw on the way out would still have persisted the inapplicable row,
    // which is the value that later becomes visible when an admin attaches the
    // field to Sessions — the whole defect.
    expect(mocks.valueUpsert).not.toHaveBeenCalled();
  });

  it("accepts a value for a field that declares this entity type alongside others", async () => {
    // The positive control: the guard must reject on APPLICABILITY, not on the
    // field being scoped at all.
    const mocks = installWithArtifactTable({
      customFieldFindFirst: vi.fn().mockResolvedValue(
        buildFieldRow({
          entityTypes: [
            CustomFieldEntityType.Document,
            CustomFieldEntityType.Session,
          ],
          fieldType: CustomFieldType.Text,
        })
      ),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Session,
      SESSION_ID,
      TEST_ORG_ID,
      "shipped"
    );

    expect(mocks.valueUpsert).toHaveBeenCalled();
  });

  it("accepts a legacy field whose entityTypes was never populated", async () => {
    // `entityTypes` is `@default([])`, so every field created before entity
    // scoping existed carries an empty one. Rejecting those would turn this
    // hardening into a breaking change for Document and Project writes that
    // work today, so empty reads as "unscoped", not as "applies to nothing".
    const mocks = installWithArtifactTable({
      customFieldFindFirst: vi
        .fn()
        .mockResolvedValue(
          buildFieldRow({ entityTypes: [], fieldType: CustomFieldType.Text })
        ),
    });

    await customFieldValuesService.setValueForEntity(
      TEST_FIELD_ID,
      CustomFieldEntityType.Session,
      SESSION_ID,
      TEST_ORG_ID,
      "shipped"
    );

    expect(mocks.valueUpsert).toHaveBeenCalled();
  });
});
