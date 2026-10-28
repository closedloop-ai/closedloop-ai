import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { BranchShellDetails } from "@repo/app/branches/components/branch-shell-details";
import { populatedDetail } from "@repo/app/branches/components/branch-story-metric-fixtures";
import { BranchesDataSourceProvider } from "@repo/app/branches/data-source/provider";
import { ENTITY_ID } from "@repo/app/custom-fields/lib/__tests__/custom-field-details-fixtures";
import {
  customFieldDetailsFields,
  customFieldDetailsRoutes,
} from "@repo/app/custom-fields/lib/__tests__/custom-field-details-host-routes";
import {
  DetailsTabGroupId,
  detailsTabGroupSelector,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createLocalBranchesDataSource } from "../local-branches-data-source";

vi.mock("@repo/app/branches/hooks/use-branch-shell-collaborators", () => ({
  useBranchShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Branch
    ),
  }),
}));

/**
 * ISS-12302: desktop Local mode has no custom-field data, so Branch Details
 * draws no Custom fields section and asks the cloud for nothing, even for a
 * branch that carries an artifact id and with an API port that would answer.
 */
describe("Branch Details custom fields in desktop Local mode", () => {
  it("draws no section and requests no definitions or values from the real Local source", async () => {
    const source = createLocalBranchesDataSource({} as never);
    const { definitions, values } = customFieldDetailsFields(
      CustomFieldEntityType.Branch
    );
    const api = customFieldDetailsRoutes({
      definitions,
      entityPath: `/branches/${ENTITY_ID}`,
      values,
    });

    expect(source.customFieldValues).toBeUndefined();

    render(
      <AppCoreStoryProviders apiRoutes={api.routes}>
        <BranchesDataSourceProvider dataSource={source}>
          <TooltipProvider>
            <BranchShellDetails
              detail={{ ...populatedDetail(), artifactId: ENTITY_ID }}
            />
          </TooltipProvider>
        </BranchesDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Repository")).toBeTruthy();
    // The Details tab drew (so the absence below is not an empty screen).
    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.ArtifactDetails)
      )
    ).not.toBeNull();
    expect(
      document.querySelector(
        detailsTabGroupSelector(DetailsTabGroupId.CustomFields)
      )
    ).toBeNull();
    expect(api.requests).toEqual([]);
  });
});
