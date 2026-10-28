import { ArtifactStatusEditSurface } from "@repo/api/src/types/artifact-status-contract";
import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { branchRowQueryKeys } from "../branch-query-keys";
import { useBranchesCustomFieldsController } from "../use-branches-custom-fields-controller";

/**
 * ISS-12663 — the Branches list reads and writes custom fields through the
 * shared list controller, addressed by each row's Branch ARTIFACT.
 */

const mocks = vi.hoisted(() => ({
  createField: vi.fn(),
  updateField: vi.fn(),
  updateValue: vi.fn(),
  useCustomFields: vi.fn(),
  useUpdateValueEntityType: vi.fn(),
}));

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutateAsync: mocks.createField }),
  useCustomFieldReferenceTargetSearch: () => vi.fn(),
  useCustomFields: (options: unknown) => mocks.useCustomFields(options),
  useUpdateCustomField: () => ({ mutateAsync: mocks.updateField }),
  useUpdateCustomFieldValueForEntityType: (
    entityType: unknown,
    surface: unknown
  ) => {
    mocks.useUpdateValueEntityType(entityType, surface);
    return { mutateAsync: mocks.updateValue };
  },
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const ARTIFACT_ID = "01a15400-0000-7000-8000-0000000000b1";
const BRANCH_FIELD = field("branch-field", [CustomFieldEntityType.Branch]);
const SESSION_FIELD = field("session-field", [CustomFieldEntityType.Session]);

const ROW: BranchRow = {
  id: "owner%2Fweb::feature-a",
  artifactId: ARTIFACT_ID,
  customFields: [],
  branchName: "feature/a",
  baseBranch: "main",
  repo: "owner/web",
  owner: "Alex Rivera",
  status: BranchRowStatus.Open,
  prNumber: null,
  prTitle: null,
  prUrl: null,
  prState: null,
  checksPassed: null,
  checksTotal: null,
  checksStatus: null,
  behind: null,
  ahead: null,
  additions: null,
  deletions: null,
  sessionCount: 1,
  commentCount: null,
  lastActivityLabel: "2h ago",
};

describe("useBranchesCustomFieldsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.updateValue.mockResolvedValue(undefined);
    mocks.useCustomFields.mockReturnValue({
      data: [BRANCH_FIELD, SESSION_FIELD],
      isSuccess: true,
    });
  });

  it("offers Branch fields as columns and keys values by the Branch artifact", () => {
    const { result } = render([ROW]);

    expect(result.current?.fields).toEqual([BRANCH_FIELD]);
    expect(result.current?.availableFields).toEqual([SESSION_FIELD]);
    expect(result.current?.valuesByEntityId.get(ARTIFACT_ID)).toEqual([]);
    expect(mocks.useUpdateValueEntityType).toHaveBeenCalledWith(
      CustomFieldEntityType.Branch,
      ArtifactStatusEditSurface.InlineCell
    );
  });

  it("attaches an existing field to Branches through Add field", async () => {
    const { result } = render([ROW]);

    await act(async () => {
      await result.current?.onAddExistingField?.(SESSION_FIELD.id);
    });

    expect(mocks.updateField).toHaveBeenCalledWith({
      id: SESSION_FIELD.id,
      entityTypes: [
        CustomFieldEntityType.Session,
        CustomFieldEntityType.Branch,
      ],
      showInTable: true,
    });
  });

  it("writes the edit and refreshes both Branches list read shapes", async () => {
    const queryClient = createTestQueryClient();
    const invalidate = vi.spyOn(queryClient, "invalidateQueries");
    const { result } = render([ROW], queryClient);

    await act(async () => {
      await result.current?.onValueChange?.(ARTIFACT_ID, BRANCH_FIELD, "Q4");
    });

    expect(mocks.updateValue).toHaveBeenCalledWith({
      entityId: ARTIFACT_ID,
      fieldId: BRANCH_FIELD.id,
      value: "Q4",
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.lists,
    });
    expect(invalidate).toHaveBeenCalledWith({
      queryKey: branchRowQueryKeys.pageData,
    });
  });

  it("withholds the controller when a row omitted the values projection", () => {
    const { customFields: _customFields, ...withoutValues } = ROW;

    expect(render([withoutValues]).result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("does not let a row with no Branch artifact hide the columns for the rest", () => {
    const { artifactId: _artifactId, customFields: _values, ...local } = ROW;
    const { result } = render([ROW, { ...local, id: "local-row" }]);

    expect(result.current?.fields).toEqual([BRANCH_FIELD]);
    expect([...(result.current?.valuesByEntityId.keys() ?? [])]).toEqual([
      ARTIFACT_ID,
    ]);
  });

  it("withholds the controller when no row on the page has a Branch artifact", () => {
    const { artifactId: _artifactId, customFields: _values, ...local } = ROW;

    expect(render([local]).result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("fires no field query when the host disables it", () => {
    renderHook(
      () => useBranchesCustomFieldsController([ROW], { enabled: false }),
      { wrapper: createWrapperWithClient(createTestQueryClient()) }
    );

    expect(mocks.useCustomFields).toHaveBeenCalledWith({ enabled: false });
  });
});

function render(
  rows: readonly BranchRow[],
  queryClient = createTestQueryClient()
) {
  return renderHook(() => useBranchesCustomFieldsController(rows), {
    wrapper: createWrapperWithClient(queryClient),
  });
}

function field(
  id: string,
  entityTypes: CustomFieldEntityType[]
): CustomFieldWithOptions {
  const timestamp = new Date("2026-10-01T00:00:00.000Z");
  return {
    id,
    organizationId: "org-1",
    name: id,
    description: null,
    fieldType: CustomFieldType.Text,
    createdById: null,
    createdAt: timestamp,
    updatedAt: timestamp,
    precision: null,
    numberFormat: null,
    currencyCode: null,
    customLabel: null,
    customLabelPosition: null,
    isGlobalToOrg: true,
    entityTypes,
    referenceTargetSources: [],
    showInTable: true,
    isSearchable: false,
    isSortable: false,
    enumOptions: [],
  };
}
