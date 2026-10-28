import {
  CustomFieldEntityType,
  CustomFieldType,
  type CustomFieldValueDetail,
  type CustomFieldWithOptions,
} from "@repo/api/src/types/custom-field";
import type { EntityListCustomFieldsController } from "@repo/app/custom-fields/hooks/use-entity-list-custom-fields-controller";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { type BranchRow, BranchRowStatus } from "../../lib/branch-row";
import { BranchesListSurfaceV2 } from "../branches-list-surface-v2";
import { branchesListSurfaceV2SummaryPropsFixture } from "./branches-list-surface-v2-props.fixtures";
import { branchesToolbarPropsFixture } from "./branches-toolbar-props.fixtures";

/**
 * ISS-12663 — the Branches list offers the org's custom-field columns and Add
 * field the way the Sessions list does, driven through the production surface
 * with the controller a host supplies.
 */

const ARTIFACT_ID = "01a15400-0000-7000-8000-0000000000b1";
const FIELD_ID = "01a15400-0000-7000-8000-0000000000f1";
const FIELD_NAME = "Quarter";
const FIELD_VALUE = "Q4 launch";
const ADD_FIELD_NAME = "Add field";
/** The shared cell's own accessible name: the field, then the row's label. */
const EDIT_CELL_NAME = /^Edit Quarter for feature\/a$/i;
const VISIBLE_COLUMNS = new Set(["owner", "status", "repo"]);
const FIXED_DATE = new Date("2026-10-01T00:00:00.000Z");

const ROW: BranchRow = {
  id: "owner%2Fweb::feature-a",
  artifactId: ARTIFACT_ID,
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
  lastActivityAt: "2026-10-01T00:00:00.000Z",
};

const FIELD: CustomFieldWithOptions = {
  id: FIELD_ID,
  organizationId: "org-1",
  name: FIELD_NAME,
  description: null,
  fieldType: CustomFieldType.Text,
  createdById: null,
  createdAt: FIXED_DATE,
  updatedAt: FIXED_DATE,
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

const VALUE: CustomFieldValueDetail = {
  customFieldId: FIELD_ID,
  dateValue: null,
  displayValue: FIELD_VALUE,
  entityId: ARTIFACT_ID,
  enumValue: null,
  fieldType: CustomFieldType.Text,
  id: "value-1",
  multiEnumValues: [],
  name: FIELD_NAME,
  numberValue: null,
  peopleValues: [],
  referenceValues: [],
  showInTable: true,
  textValue: FIELD_VALUE,
};

describe("Branches list custom-field columns (ISS-12663)", () => {
  it("draws a column per Branch field, with each row's own value", () => {
    renderSurface({ customFields: controller() });

    expect(
      screen.getByRole("columnheader", { name: FIELD_NAME })
    ).toBeInTheDocument();
    expect(screen.getByText(FIELD_VALUE)).toBeInTheDocument();
  });

  it("offers Add field, and opens the shared Add field dialog from the header", async () => {
    const user = userEvent.setup();
    renderSurface({ customFields: controller() });

    await user.click(screen.getByRole("button", { name: ADD_FIELD_NAME }));

    expect(await screen.findByRole("dialog")).toBeInTheDocument();
  });

  it("keeps custom fields and Add field after rollout row actions", () => {
    renderSurface({ customFields: controller(), rolloutEnabled: true });

    expect(
      screen.getByRole("columnheader", { name: FIELD_NAME })
    ).toBeVisible();
    expect(screen.getByRole("columnheader", { name: "Actions" })).toBeVisible();
    // ISS-13007: the toolbar offers Add field too, so pick the header's own.
    const addField = screen
      .getAllByRole("button", { name: ADD_FIELD_NAME })
      .find((button) => button.closest('[role="columnheader"]'));
    expect(addField?.closest('[role="columnheader"]')).toHaveAttribute(
      "aria-colindex",
      String(screen.getAllByRole("columnheader").length)
    );
  });

  it("reaches Add field from the keyboard through the header's roving walk", () => {
    renderSurface({ customFields: controller() });

    const addField = screen.getByRole("button", { name: ADD_FIELD_NAME });
    const header = addField.closest('[role="columnheader"]');

    expect(header).not.toBeNull();
    expect(header).toHaveAttribute("data-grid-cell");
  });

  it("offers no Add field where the host cannot create a field", () => {
    const { onCreateField: _onCreateField, ...readOnly } = controller();
    renderSurface({ customFields: readOnly });

    expect(
      screen.getByRole("columnheader", { name: FIELD_NAME })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_FIELD_NAME })
    ).not.toBeInTheDocument();
  });

  it("draws neither the columns nor Add field without a controller", () => {
    renderSurface({ customFields: undefined });

    expect(
      screen.queryByRole("columnheader", { name: FIELD_NAME })
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: ADD_FIELD_NAME })
    ).not.toBeInTheDocument();
  });

  it("lists the field in the Columns menu and hides its column from there", async () => {
    const user = userEvent.setup();
    renderSurface({ customFields: controller() });
    expect(
      screen.getByRole("columnheader", { name: FIELD_NAME })
    ).toBeInTheDocument();

    await user.click(screen.getByRole("button", { name: "Options" }));
    await user.click(await screen.findByRole("menuitem", { name: FIELD_NAME }));

    expect(
      screen.queryByRole("columnheader", { name: FIELD_NAME })
    ).not.toBeInTheDocument();
  });

  it("writes an edit against the Branch artifact, not the list row id", async () => {
    const onValueChange = vi.fn().mockResolvedValue(undefined);
    renderSurface({ customFields: controller({ onValueChange }) });

    fireEvent.click(screen.getByRole("button", { name: EDIT_CELL_NAME }));
    const input = screen.getByRole("textbox", { name: EDIT_CELL_NAME });
    fireEvent.change(input, { target: { value: "Q1" } });
    fireEvent.keyDown(input, { key: "Enter" });

    await waitFor(() =>
      expect(onValueChange).toHaveBeenCalledWith(ARTIFACT_ID, FIELD, "Q1")
    );
  });
});

function controller(
  overrides: Partial<EntityListCustomFieldsController> = {}
): EntityListCustomFieldsController {
  return {
    availableFields: [],
    fields: [FIELD],
    onCreateField: vi.fn(),
    onValueChange: vi.fn(),
    valuesByEntityId: new Map([[ARTIFACT_ID, [VALUE]]]),
    ...overrides,
  };
}

function renderSurface({
  customFields,
  rolloutEnabled = false,
}: {
  customFields: EntityListCustomFieldsController | undefined;
  rolloutEnabled?: boolean;
}) {
  const surface = (
    <BranchesListSurfaceV2
      allRows={[ROW]}
      customFields={customFields}
      hasActiveFilters={false}
      hasWindow={false}
      isError={false}
      isPending={false}
      isPlaceholderData={false}
      items={[ROW]}
      onPageChange={() => undefined}
      onPageSizeChange={() => undefined}
      onRetry={() => undefined}
      onShowAllTime={() => undefined}
      onSort={() => undefined}
      page={0}
      pageSize={25}
      sortBy="lastActivity"
      sortDir="desc"
      {...branchesListSurfaceV2SummaryPropsFixture()}
      toolbar={branchesToolbarPropsFixture({
        rows: [ROW],
        visibleColumns: VISIBLE_COLUMNS,
      })}
      total={1}
      totalPages={1}
      visibleColumns={VISIBLE_COLUMNS}
    />
  );
  if (rolloutEnabled) {
    return render(
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({
          enabledFlags: [GRIDVIEW_ADOPTION_FEATURE_FLAG_KEY],
        })}
      >
        {surface}
      </FeatureFlagAdapterProvider>
    );
  }
  return render(surface);
}
