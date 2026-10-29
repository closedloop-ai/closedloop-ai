import type { AgentSessionDetail } from "@repo/api/src/types/agent-session";
import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { CustomFieldEntityType } from "@repo/api/src/types/custom-field";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
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
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { SessionShellDetails } from "../session-shell-details";

/** ISS-12302 / PLN-2173 M3: custom fields on the Session Details tab. */

vi.mock("../../../hooks/use-session-shell-collaborators", () => ({
  useSessionShellCollaborators: () => ({
    collaborators: unavailableArtifactCollaborators(
      CollaboratorArtifactType.Session
    ),
  }),
}));

const ITEM_LABEL = "Session one";
const ENTITY_PATH = `/agent-sessions/${ENTITY_ID}`;
const session = createAgentSessionDetailFixture({
  id: ENTITY_ID,
  name: ITEM_LABEL,
});

function details(detail: AgentSessionDetail = session) {
  return (
    <TooltipProvider>
      <SessionShellDetails
        displayedStatus={SESSION_STATUS.INACTIVE}
        session={detail}
      />
    </TooltipProvider>
  );
}

function renderWithApi(
  routes: FixtureRoute[],
  detail: AgentSessionDetail = session
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

describeCustomFieldDetailsSaveTriggers({
  entityPath: ENTITY_PATH,
  entityType: CustomFieldEntityType.Session,
  itemLabel: ITEM_LABEL,
  renderHost: renderWithApi,
});

describe("Session Details custom fields on an unnamed session", () => {
  it("names each editor after the session id the page heading falls back to", async () => {
    const unnamed = { ...session, name: null };
    const { definitions, values } = customFieldDetailsFields(
      CustomFieldEntityType.Session
    );
    const api = customFieldDetailsRoutes({
      definitions,
      entityPath: ENTITY_PATH,
      values,
    });

    renderWithApi(api.routes, unnamed);

    expect(
      await screen.findByRole("button", {
        name: `Edit Labels for ${session.externalSessionId}`,
      })
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: "Edit Labels for" })
    ).toBeNull();
  });
});

describe("Session Details custom fields without a reader", () => {
  it("mounts without an API port or data source, and draws no section", () => {
    render(details(), {
      wrapper: createWrapperWithClient(createTestQueryClient()),
    });

    expect(screen.getByText("Session ID")).toBeInTheDocument();
    expect(customFieldsSection()).toBeNull();
  });
});
