import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import {
  type BranchRow,
  BranchRowStatus,
} from "@repo/app/branches/lib/branch-row";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useDesktopBranchesCustomFieldsController } from "../use-desktop-branches-custom-fields-controller";

/**
 * ISS-12663: the desktop Branches list's half of the custom-field columns, the
 * same mode opt-in and the same withheld field-definition writes as the desktop
 * Sessions list (ISS-12455).
 */

const mocks = vi.hoisted(() => ({
  useCustomFields: vi.fn(),
}));

vi.mock("@repo/app/custom-fields/hooks/use-custom-fields", () => ({
  useCreateCustomField: () => ({ mutateAsync: vi.fn() }),
  useCustomFieldReferenceTargetSearch: () => vi.fn(),
  useCustomFields: (options: unknown) => mocks.useCustomFields(options),
  useUpdateCustomField: () => ({ mutateAsync: vi.fn() }),
  useUpdateCustomFieldValueForEntityType: () => ({ mutateAsync: vi.fn() }),
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useOrganizationUsers: () => ({ data: [] }),
}));

const BRANCH_FIELD: CustomFieldWithOptions = {
  id: "branch-field",
  organizationId: "org-1",
  name: "branch-field",
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: new Date("2026-10-01T00:00:00.000Z"),
  updatedAt: new Date("2026-10-01T00:00:00.000Z"),
  precision: null,
  numberFormat: null,
  currencyCode: null,
  customLabel: null,
  customLabelPosition: null,
  isGlobalToOrg: true,
  entityTypes: [CustomFieldEntityType.Branch],
  referenceTargetSources: [],
  showInTable: true,
  isSearchable: false,
  isSortable: false,
  enumOptions: [],
};

const ROW: BranchRow = {
  id: "owner%2Fweb::feature-a",
  artifactId: "01a15400-0000-7000-8000-0000000000b1",
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

describe("useDesktopBranchesCustomFieldsController", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.useCustomFields.mockReturnValue({
      data: [BRANCH_FIELD],
      isSuccess: true,
    });
  });

  it("opts in on cloud mode and out on local mode", () => {
    expect(render(true).result.current).not.toBeUndefined();
    expect(render(false).result.current).toBeUndefined();
    expect(mocks.useCustomFields).toHaveBeenLastCalledWith({ enabled: false });
  });

  it("withholds field-definition writes and keeps value edits, in cloud mode", () => {
    const { result } = render(true);

    expect(result.current?.onCreateField).toBeUndefined();
    expect(result.current?.onAddExistingField).toBeUndefined();
    expect(result.current?.availableFields).toBeUndefined();
    expect(typeof result.current?.onValueChange).toBe("function");
    expect(result.current?.fields).toEqual([BRANCH_FIELD]);
  });
});

function render(isCloudMode: boolean) {
  return renderHook(
    () => useDesktopBranchesCustomFieldsController(isCloudMode, [ROW]),
    { wrapper: createWrapperWithClient(createTestQueryClient()) }
  );
}
