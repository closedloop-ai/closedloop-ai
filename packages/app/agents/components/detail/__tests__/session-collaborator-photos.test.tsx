import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import {
  DetailsTabArtifactType,
  shippedDetailsTabConfig,
} from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-model";
import { DetailsTabSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-tab-sections";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { createAgentSessionDetailFixture } from "../agent-session-detail-fixtures";
import { sessionShellDetailsConfig } from "../session-shell-details";

// The shared helper is loaded INSIDE the factory, not imported at the top:
// `vi.mock` hoists above every import, and this file's other `@repo/app/*`
// imports sort before `@repo/app/test/*`, so a static binding is still
// uninitialised when the factory runs.
vi.mock("@repo/design-system/components/ui/avatar", async (importOriginal) => {
  const { avatarImageMockModule } = await import(
    "@repo/app/test/mocks/avatar-image"
  );
  return avatarImageMockModule(importOriginal);
});

/**
 * ISS-12269's change 4, inherited by ISS-12273: the Session collaborators show
 * each person's PICTURE.
 *
 * This is the evidence that the photo RENDERS, not that the widget was
 * imported. Swapping in the shared `Collaborators` widget only makes a picture
 * possible: `collaboratorPeople()` used to map `{ id, name }` and drop
 * `avatarUrl`, which the wire does carry
 * (`packages/api/src/types/artifact-collaborators.ts`), and a widget handed no
 * url renders initials exactly as before — change 4 would have read as
 * satisfied with nothing on screen.
 *
 * Radix gates `AvatarImage` on a real load and jsdom never loads one, so the
 * shared `avatarImageMockModule` stands in. Its bound: it forwards only `alt`
 * and `src`, so these cases claim nothing beyond the `src` that reached the
 * DOM. Hover tooltips and anything else the real Radix node contributes belong
 * to a browser.
 */
const PHOTO_URL = "https://img.example.test/morgan.png";

describe("Session collaborators render their photos (ISS-12273)", () => {
  it("renders the photo the producer sent", () => {
    const { container } = renderCollaborators([
      {
        avatarUrl: PHOTO_URL,
        displayName: "Morgan Photo",
        id: "user_photo",
        provider: BranchPersonProvider.ClosedLoop,
      },
    ]);

    expect(container.querySelector(`img[src="${PHOTO_URL}"]`)).not.toBeNull();
  });

  it("renders no photo for a person the producer sent none for", () => {
    // The counterfactual. Without it the case above passes against a widget
    // that hardcoded any `src`, and the dropped-field regression this file
    // exists to catch would be invisible.
    const { container } = renderCollaborators([
      {
        displayName: "Sam Nophoto",
        id: "user_nophoto",
        provider: BranchPersonProvider.ClosedLoop,
      },
    ]);

    expect(container.querySelector("img")).toBeNull();
  });

  it("renders one photo per person when only some have one", () => {
    const { container } = renderCollaborators([
      {
        avatarUrl: PHOTO_URL,
        displayName: "Morgan Photo",
        id: "user_photo",
        provider: BranchPersonProvider.ClosedLoop,
      },
      {
        displayName: "Sam Nophoto",
        id: "user_nophoto",
        provider: BranchPersonProvider.ClosedLoop,
      },
    ]);

    expect(container.querySelectorAll("img")).toHaveLength(1);
  });
});

type TestPerson = {
  avatarUrl?: string;
  displayName: string;
  id: string;
  provider: BranchPersonProvider;
};

/** The production path: the real mapper, the real row, the real widget. */
function renderCollaborators(people: readonly TestPerson[]) {
  const collaborators = {
    ...unavailableArtifactCollaborators(CollaboratorArtifactType.Session),
    availability: BranchIdentityAvailability.Complete,
    people,
  } as unknown as Parameters<typeof sessionShellDetailsConfig>[1];
  const rendered = render(
    <TooltipProvider>
      <DetailsTabSections
        config={shippedDetailsTabConfig(
          DetailsTabArtifactType.Session,
          sessionShellDetailsConfig(
            {
              displayedStatus: SESSION_STATUS.INACTIVE,
              session: createAgentSessionDetailFixture(),
            },
            collaborators
          )
        )}
        priorityEditor={ArtifactPriorityEditor}
      />
    </TooltipProvider>
  );
  const cell = document.querySelector<HTMLElement>(
    `[data-details-field="${DetailsFieldId.Collaborators}"] > :last-child`
  );
  if (!cell) {
    throw new Error("Expected a drawn Collaborators row");
  }
  return { ...rendered, container: cell };
}
