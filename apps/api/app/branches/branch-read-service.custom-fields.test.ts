import {
  CustomFieldEntityType,
  CustomFieldType,
} from "@repo/api/src/types/custom-field";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@repo/database", async () => {
  const { createDatabaseMockModule } = await import(
    "../../__tests__/fixtures/mock-modules"
  );
  return createDatabaseMockModule({ ChecksStatus: { UNKNOWN: "UNKNOWN" } });
});

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), warn: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import { log } from "@repo/observability/log";
import { withSeededPushSessionCreators } from "@/__tests__/support/branches/branch-evidence-link.test-fixtures";
import {
  branchId,
  createMockDb,
  makeBranchRow,
  mockBranchCandidatePage,
  now,
  organizationId,
} from "@/__tests__/support/branches/branch-read-service.test-helpers";
import { mockWithDbCall, mockWithDbTx } from "../../__tests__/utils/db-helpers";
import {
  BranchListEnrichmentRead,
  branchListEnrichmentFailureThrottle,
} from "./branch-list-enrichment";
import { branchReadService } from "./branch-read-service";

/**
 * ISS-12663 — the Branches list carries each row's org custom-field values, the
 * projection the Sessions list already carries, driven through the real
 * `listBranches` so the wiring is what is pinned.
 */

const FIELD_ID = "01a15400-0000-7000-8000-00000000f1e1";

afterEach(() => {
  vi.useRealTimers();
  branchListEnrichmentFailureThrottle.clear();
});

describe("Branch list custom-field values (ISS-12663)", () => {
  let mockDb: ReturnType<typeof createMockDb>;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.setSystemTime(now);
    mockDb = createMockDb();
    mockWithDbCall(withSeededPushSessionCreators(mockDb));
    mockWithDbTx(withSeededPushSessionCreators(mockDb));
    mockDb.commitDetail.findMany.mockResolvedValue([]);
    mockBranchCandidatePage(mockDb, [branchId]);
    mockDb.artifact.findMany.mockResolvedValue([
      makeBranchRow({ firstPushedAt: now }),
    ]);
  });

  it("attaches the page's values through one org-scoped Branch read", async () => {
    mockDb.customFieldValue.findMany.mockResolvedValue([
      textValueRow(branchId, "Q4"),
    ]);

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(mockDb.customFieldValue.findMany).toHaveBeenCalledTimes(1);
    const where = mockDb.customFieldValue.findMany.mock.calls[0]?.[0]?.where;
    expect(where).toMatchObject({
      entityType: CustomFieldEntityType.Branch,
      entityId: { in: [branchId] },
      organizationId,
    });
    expect(response.items[0]?.customFields).toEqual([
      expect.objectContaining({
        customFieldId: FIELD_ID,
        displayValue: "Q4",
        entityId: branchId,
      }),
    ]);
  });

  it("states an empty read as [] rather than omitting the field", async () => {
    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items[0]?.customFields).toEqual([]);
  });

  it("returns the rows without the field, and reports it, when the read fails", async () => {
    mockDb.customFieldValue.findMany.mockRejectedValue(
      new Error("statement timeout")
    );

    const response = await branchReadService.listBranches(organizationId, {
      limit: 50,
      offset: 0,
    });

    expect(response.items).toHaveLength(1);
    expect(response.items[0]).not.toHaveProperty("customFields");
    expect(log.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        organizationId,
        read: BranchListEnrichmentRead.CustomFieldValues,
      })
    );
  });
});

function textValueRow(entityId: string, text: string) {
  return {
    id: `value-${entityId}`,
    customFieldId: FIELD_ID,
    organizationId,
    entityType: CustomFieldEntityType.Branch,
    entityId,
    textValue: text,
    numberValue: null,
    dateValue: null,
    enumValueId: null,
    multiEnumValueIds: [],
    peopleValueIds: [],
    displayValue: text,
    createdAt: now,
    updatedAt: now,
    enumValue: null,
    references: [],
    customField: {
      id: FIELD_ID,
      name: "Quarter",
      fieldType: CustomFieldType.Text,
      showInTable: true,
      enumOptions: [],
    },
  };
}
