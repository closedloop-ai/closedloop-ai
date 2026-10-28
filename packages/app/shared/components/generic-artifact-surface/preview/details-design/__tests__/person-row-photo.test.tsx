import {
  CollaboratorArtifactType,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { BasicUser } from "@repo/api/src/types/user";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { sessionShellDetailsConfig } from "@repo/app/agents/components/detail/session-shell-details";
import { branchShellDetailsConfig } from "@repo/app/branches/components/branch-shell-details";
import { populatedDetail } from "@repo/app/branches/components/branch-story-metric-fixtures";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { DetailsSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-sections";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

// Loaded INSIDE the factory, not imported at the top: `vi.mock` hoists above
// every import, and this file's other `@repo/app/*` imports sort before
// `@repo/app/test/*`, so a static binding is still uninitialised here.
vi.mock("@repo/design-system/components/ui/avatar", async (importOriginal) => {
  const { avatarImageMockModule } = await import(
    "@repo/app/test/mocks/avatar-image"
  );
  return avatarImageMockModule(importOriginal);
});

/**
 * ISS-12341: Owner and Created by show the person's PICTURE.
 *
 * The evidence is a rendered photo, not an imported component. `personValue()`
 * mapped `{ choices, kind, name }` and dropped `BasicUser.avatarUrl`, so a row
 * converted to `PersonAvatar` alone would still draw initials and read exactly
 * as it did before — which is how this class of fix reads as satisfied with
 * nothing on screen. Each case therefore drives the REAL producer
 * (`sessionShellDetailsConfig` / `branchShellDetailsConfig`, both through the
 * shared `personValue`) and asserts the `src` that reached the DOM.
 *
 * Radix gates `AvatarImage` on a real load and jsdom loads none, so the shared
 * `avatarImageMockModule` stands in. Its bound: it forwards only `alt` and
 * `src`, so these cases claim nothing beyond the `src`.
 */
const OWNER_PHOTO = "https://img.example.test/ada.png";
const CREATOR_PHOTO = "https://img.example.test/grace.png";

describe("Session Owner and Created by render their photos (ISS-12341)", () => {
  it("renders the photo the producer sent for each person row", () => {
    const rows = renderSessionRows({
      createdBy: person("user-grace", "Grace", CREATOR_PHOTO),
      user: person("user-ada", "Ada", OWNER_PHOTO),
    });

    expect(photoIn(rows, DetailsFieldId.Owner)).toBe(OWNER_PHOTO);
    expect(photoIn(rows, DetailsFieldId.CreatedBy)).toBe(CREATOR_PHOTO);
  });

  it("renders no photo for a person the producer sent none for", () => {
    // The counterfactual. Without it the case above passes against a row that
    // hardcoded any `src`, and the dropped-field regression this file exists
    // to catch would be invisible.
    const rows = renderSessionRows({
      createdBy: person("user-grace", "Grace", null),
      user: person("user-ada", "Ada", null),
    });

    expect(photoIn(rows, DetailsFieldId.Owner)).toBeNull();
    expect(photoIn(rows, DetailsFieldId.CreatedBy)).toBeNull();
  });

  // Per row, not per config: one row carrying a photo while the other does not
  // is what tells a shared mapper from a row that happens to read the right
  // field. A single-person fixture cannot distinguish them.
  it("renders the photo only on the row whose person has one", () => {
    const rows = renderSessionRows({
      createdBy: person("user-grace", "Grace", null),
      user: person("user-ada", "Ada", OWNER_PHOTO),
    });

    expect(photoIn(rows, DetailsFieldId.Owner)).toBe(OWNER_PHOTO);
    expect(photoIn(rows, DetailsFieldId.CreatedBy)).toBeNull();
  });
});

describe("Branch Owner and Created by render their photos (ISS-12341)", () => {
  it("renders the photo the producer sent", () => {
    const rows = renderBranchRows(
      person("user-sam", "Sam", OWNER_PHOTO),
      person("user-alex", "Alex", CREATOR_PHOTO)
    );

    expect(photoIn(rows, DetailsFieldId.Owner)).toBe(OWNER_PHOTO);
    expect(photoIn(rows, DetailsFieldId.CreatedBy)).toBe(CREATOR_PHOTO);
  });

  it("renders no photo for a person the producer sent none for", () => {
    const rows = renderBranchRows(
      person("user-sam", "Sam", null),
      person("user-alex", "Alex", null)
    );

    expect(photoIn(rows, DetailsFieldId.Owner)).toBeNull();
    expect(photoIn(rows, DetailsFieldId.CreatedBy)).toBeNull();
  });
});

function person(id: string, firstName: string, avatarUrl: string | null) {
  return {
    avatarUrl,
    email: `${id}@example.test`,
    firstName,
    id,
    lastName: "Tester",
  } satisfies BasicUser;
}

function renderSessionRows(people: {
  createdBy: BasicUser;
  user: BasicUser;
}): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <DetailsSections
        config={sessionShellDetailsConfig(
          {
            displayedStatus: SESSION_STATUS.INACTIVE,
            session: createAgentSessionDetailFixture(people),
          },
          unavailableArtifactCollaborators(CollaboratorArtifactType.Session)
        )}
        priorityEditor={ArtifactPriorityEditor}
      />
    </TooltipProvider>
  );
  return container;
}

function renderBranchRows(
  assignee: BasicUser,
  createdBy: BasicUser
): HTMLElement {
  const { container } = render(
    <TooltipProvider>
      <DetailsSections
        config={branchShellDetailsConfig(
          { detail: { ...populatedDetail(), assignee, createdBy } },
          unavailableArtifactCollaborators(CollaboratorArtifactType.Branch)
        )}
        priorityEditor={ArtifactPriorityEditor}
      />
    </TooltipProvider>
  );
  return container;
}

/** The `src` the row actually drew, or null when it drew initials instead. */
function photoIn(container: HTMLElement, fieldId: string): string | null {
  const row = container.querySelector<HTMLElement>(
    `[data-details-field="${fieldId}"]`
  );
  if (!row) {
    throw new Error(`Expected a drawn ${fieldId} row`);
  }
  return row.querySelector("img")?.getAttribute("src") ?? null;
}
