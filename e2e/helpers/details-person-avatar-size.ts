/**
 * ISS-12494: the Session Details Owner avatar and the Collaborators avatars
 * directly below it paint at one size. Shared by the web spec
 * (`e2e/details-person-avatar-size.spec.ts`) and its Electron twin
 * (`apps/desktop/test/e2e/details-person-row-photo.spec.ts`), so both shells
 * serve the same people and assert the same boxes.
 */

import { expect, type Locator } from "@playwright/test";
// `.ts` is load-bearing on these VALUE imports: the desktop spec loader does
// not resolve extensionless specifiers, and a load failure aborts its suite.
import {
  type ArtifactCollaboratorBatchResponse,
  CollaboratorArtifactType,
  SessionCollaboratorSource,
  unavailableArtifactCollaborators,
} from "@repo/api/src/types/artifact-collaborators.ts";
import {
  BranchIdentityAvailability,
  type BranchPerson,
  BranchPersonProvider,
} from "@repo/api/src/types/branch-identity.ts";
import type { BasicUser } from "@repo/api/src/types/user";
import { DetailsFieldId } from "@repo/app/shared/components/generic-artifact-surface/preview/details-design/details-design-model.ts";
import { DETAILS_SESSION_UPLOADER } from "./details-person-row-photo-fixture";

/** The Session's Owner (`assignee`), who also appears among Collaborators. */
export const AVATAR_SIZE_OWNER: BasicUser = {
  ...DETAILS_SESSION_UPLOADER,
  firstName: "Daveth",
  id: "iss-12494-owner",
  lastName: "Oakhurst",
};

/** The single-collaborator and overflowing-stack cases the ticket asks for. */
export const AVATAR_SIZE_COLLABORATOR_SETS: readonly [
  string,
  BranchPerson[],
][] = [
  ["one collaborator", [person(AVATAR_SIZE_OWNER.id, "Daveth Oakhurst")]],
  [
    "several collaborators",
    [
      person(AVATAR_SIZE_OWNER.id, "Daveth Oakhurst"),
      person("iss-12494-ada", "Ada Lovelace"),
      person("iss-12494-grace", "Grace Hopper"),
      person("iss-12494-sam", "Sam Uploader"),
    ],
  ],
];

/** The Collaborators widget draws at most this many avatars before `+N`. */
const VISIBLE_COLLABORATORS = 3;

/** The `/artifacts/collaborators` answer naming `people` for every session asked about. */
export function avatarSizeCollaboratorBatch(
  artifactIds: readonly string[],
  people: BranchPerson[]
): ArtifactCollaboratorBatchResponse {
  const unavailable = unavailableArtifactCollaborators(
    CollaboratorArtifactType.Session
  );
  return {
    results: artifactIds.map((artifactId) => ({
      artifactId,
      artifactType: CollaboratorArtifactType.Session,
      collaborators: {
        availability: BranchIdentityAvailability.Complete,
        people,
        sources: {
          ...unavailable.sources,
          [SessionCollaboratorSource.Owner]:
            BranchIdentityAvailability.Complete,
        },
      },
    })),
  };
}

/** Owner and every drawn Collaborators avatar paint the same box. */
export async function expectOwnerAndCollaboratorAvatarsShareOneSize(
  details: Locator,
  people: readonly BranchPerson[]
): Promise<void> {
  const owner = avatars(details, DetailsFieldId.Owner);
  const collaborators = avatars(details, DetailsFieldId.Collaborators);
  await expect(owner).toHaveCount(1);
  await expect(collaborators).toHaveCount(
    Math.min(people.length, VISIBLE_COLLABORATORS)
  );

  const ownerBox = await owner.boundingBox();
  expect(ownerBox).not.toBeNull();
  for (const avatar of await collaborators.all()) {
    const box = await avatar.boundingBox();
    expect(box?.width).toBe(ownerBox?.width);
    expect(box?.height).toBe(ownerBox?.height);
  }
}

function person(id: string, displayName: string): BranchPerson {
  return {
    displayName,
    id,
    provider: BranchPersonProvider.ClosedLoop,
    userId: id,
  };
}

/**
 * Every avatar a row painted, located through its initials: the Collaborators
 * tooltip trigger overwrites the avatar's own `data-slot`, and no person here
 * carries a photo.
 */
function avatars(panel: Locator, fieldId: DetailsFieldId): Locator {
  return panel
    .locator(`[data-details-field="${fieldId}"]`)
    .locator('[data-slot="avatar-fallback"]')
    .locator("..");
}
