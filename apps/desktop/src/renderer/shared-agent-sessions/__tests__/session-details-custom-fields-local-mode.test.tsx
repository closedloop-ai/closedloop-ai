import { TooltipProvider } from "@closedloop-ai/design-system/components/ui/tooltip";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { SessionShellDetails } from "@repo/app/agents/components/detail/session-shell-details";
import { AgentSessionsDataSourceProvider } from "@repo/app/agents/data-source/provider";
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
import { createLocalAgentSessionsDataSource } from "../local-agent-sessions-data-source";

vi.mock("@repo/app/agents/hooks/use-session-shell-collaborators", () => ({
  useSessionShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Session
    ),
  }),
}));

/**
 * ISS-12302: desktop Local mode has no custom-field data, so Session Details
 * draws no Custom fields section and asks the cloud for nothing, even with an
 * API port mounted that would answer.
 */
describe("Session Details custom fields in desktop Local mode", () => {
  it("draws no section and requests no definitions or values from the real Local source", async () => {
    const source = createLocalAgentSessionsDataSource({
      agentSessionsApi: {},
    } as never);
    const { definitions, values } = customFieldDetailsFields(
      CustomFieldEntityType.Session
    );
    const api = customFieldDetailsRoutes({
      definitions,
      entityPath: `/agent-sessions/${ENTITY_ID}`,
      values,
    });

    expect(source.customFieldValues).toBeUndefined();

    render(
      <AppCoreStoryProviders apiRoutes={api.routes}>
        <AgentSessionsDataSourceProvider dataSource={source}>
          <TooltipProvider>
            <SessionShellDetails
              displayedStatus={SESSION_STATUS.INACTIVE}
              session={createAgentSessionDetailFixture({ id: ENTITY_ID })}
            />
          </TooltipProvider>
        </AgentSessionsDataSourceProvider>
      </AppCoreStoryProviders>
    );

    expect(await screen.findByText("Session ID")).toBeTruthy();
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
