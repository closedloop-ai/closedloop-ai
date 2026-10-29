import {
  CollaboratorArtifactType,
  type SessionCollaborators,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators";
import {
  BranchIdentityAvailability,
  type BranchPerson,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity";
import { SESSION_STATUS } from "@repo/api/src/types/session-status";
import type { BasicUser } from "@repo/api/src/types/user";
import { createAgentSessionDetailFixture } from "@repo/app/agents/components/detail/agent-session-detail-fixtures";
import { sessionShellDetailsConfig } from "@repo/app/agents/components/detail/session-shell-details";
import { ArtifactPriorityEditor } from "@repo/app/documents/components/artifact-priority/artifact-priority-editor";
import { COLLABORATOR_AVATAR_SIZE_CLASS_NAME } from "@repo/app/shared/components/collaborators";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model";
import { DetailsSections } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-sections";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { render } from "@testing-library/react";
import { describe, expect, it } from "vitest";

/**
 * ISS-12494: Owner sat directly above Collaborators with a larger avatar for
 * the same person (SES-97307). jsdom lays nothing out, so the size each row
 * drew is read from its avatar's `size-*` class, through the real producer.
 */
const SIZE_CLASS = /^size-/;

describe("Session Details person avatars share one size (ISS-12494)", () => {
  it.each([
    ["one collaborator", [collaborator("user_1", "Daveth Oakhurst")]],
    [
      "several collaborators",
      [
        collaborator("user_1", "Daveth Oakhurst"),
        collaborator("user_2", "Ada Tester"),
        collaborator("user_3", "Grace Tester"),
        collaborator("user_4", "Sam Tester"),
      ],
    ],
  ])(
    "draws Owner, Created by and %s at the Collaborators size",
    (_, people) => {
      const container = renderSessionRows(people);

      const sizes = [
        ...avatarSizes(container, DetailsFieldId.Owner),
        ...avatarSizes(container, DetailsFieldId.CreatedBy),
        ...avatarSizes(container, DetailsFieldId.Collaborators),
      ];

      expect(sizes.length).toBe(2 + Math.min(people.length, 3));
      expect(new Set(sizes)).toEqual(
        new Set([COLLABORATOR_AVATAR_SIZE_CLASS_NAME])
      );
    }
  );
});

function collaborator(id: string, displayName: string): BranchPerson {
  return { displayName, id, provider: BranchPersonProvider.ClosedLoop };
}

function user(id: string, firstName: string): BasicUser {
  return {
    avatarUrl: null,
    email: `${id}@example.test`,
    firstName,
    id,
    lastName: "Tester",
  };
}

function renderSessionRows(people: BranchPerson[]): HTMLElement {
  const collaborators: SessionCollaborators = {
    ...unavailableArtifactCollaborators(CollaboratorArtifactType.Session),
    availability: BranchIdentityAvailability.Complete,
    people,
  };
  const { container } = render(
    <TooltipProvider>
      <DetailsSections
        config={sessionShellDetailsConfig(
          {
            displayedStatus: SESSION_STATUS.INACTIVE,
            session: createAgentSessionDetailFixture({
              assignee: user("user_1", "Daveth"),
              createdBy: user("user_2", "Ada"),
            }),
          },
          collaborators
        )}
        priorityEditor={ArtifactPriorityEditor}
      />
    </TooltipProvider>
  );
  return container;
}

/** The `size-*` class of every avatar a row drew. */
function avatarSizes(container: HTMLElement, fieldId: string): string[] {
  const row = container.querySelector<HTMLElement>(
    `[data-details-field="${fieldId}"]`
  );
  if (!row) {
    throw new Error(`Expected a drawn ${fieldId} row`);
  }
  // The fallback, because the Collaborators tooltip trigger overwrites the
  // avatar's own `data-slot`; these fixtures carry no photo, so every avatar
  // draws one.
  return [
    ...row.querySelectorAll<HTMLElement>('[data-slot="avatar-fallback"]'),
  ].map(
    (fallback) =>
      [...(fallback.parentElement?.classList ?? [])].find((name) =>
        SIZE_CLASS.test(name)
      ) ?? "none"
  );
}
