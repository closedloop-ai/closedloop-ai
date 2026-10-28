import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import type { BranchPageDetail } from "@repo/api/src/types/branch";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { ENTITY_ID } from "@repo/app/custom-fields/lib/__tests__/custom-field-details-fixtures";
import {
  customFieldDetailsFields,
  customFieldDetailsRoutes,
} from "@repo/app/custom-fields/lib/__tests__/custom-field-details-host-routes";
import { describeCustomFieldDetailsSaveTriggers } from "@repo/app/custom-fields/lib/__tests__/custom-field-details-host-suite";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import {
  createTestQueryClient,
  createWrapperWithClient,
} from "@repo/app/shared/test-utils";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { BranchShellDetails } from "../branch-shell-details";
import { populatedDetail } from "../branch-story-metric-fixtures";

/** ISS-12302 / PLN-2173 M4: custom fields on the Branch Details tab. */

vi.mock("../../hooks/use-branch-shell-collaborators", () => ({
  useBranchShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Branch
    ),
  }),
}));

const ENTITY_PATH = `/branches/${ENTITY_ID}`;

function branchDetail(
  overrides: Partial<BranchPageDetail> = {}
): BranchPageDetail {
  return { ...populatedDetail(), artifactId: ENTITY_ID, ...overrides };
}

function details(detail: BranchPageDetail = branchDetail()) {
  return (
    <TooltipProvider>
      <BranchShellDetails detail={detail} />
    </TooltipProvider>
  );
}

function renderWithApi(
  routes: FixtureRoute[],
  detail: BranchPageDetail = branchDetail()
) {
  render(
    <AppCoreStoryProviders
      apiRoutes={routes}
      enabledFlags={[CUSTOM_FIELD_VALUE_CLEAR_FEATURE_FLAG_KEY]}
    >
      {details(detail)}
    </AppCoreStoryProviders>
  );
}

function customFieldsSection() {
  return document.querySelector(
    detailsTabGroupSelector(DetailsTabGroupId.CustomFields)
  );
}

function branchRoutes() {
  const { definitions, values } = customFieldDetailsFields(
    CustomFieldEntityType.Branch
  );
  return customFieldDetailsRoutes({
    definitions,
    entityPath: ENTITY_PATH,
    values,
  });
}

describeCustomFieldDetailsSaveTriggers({
  entityPath: ENTITY_PATH,
  entityType: CustomFieldEntityType.Branch,
  itemLabel: branchDetail().branchName,
  renderHost: (routes) => renderWithApi(routes),
});

describe("Branch Details custom fields without a reader", () => {
  it("draws no section and reads nothing for a branch with no artifact", async () => {
    const api = branchRoutes();

    renderWithApi(api.routes, branchDetail({ artifactId: undefined }));

    expect(await screen.findByText("Repository")).toBeInTheDocument();
    expect(customFieldsSection()).toBeNull();
    expect(api.requests).toEqual([]);
  });

  it("mounts without an API port or data source, and draws no section", () => {
    render(details(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    expect(screen.getByText("Repository")).toBeInTheDocument();
    expect(customFieldsSection()).toBeNull();
  });
});
