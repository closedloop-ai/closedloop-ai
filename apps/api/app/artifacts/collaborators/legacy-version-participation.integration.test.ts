import { ArtifactType } from "@repo/api/src/types/artifact";
import { DirectCollaboratorSource } from "@repo/api/src/types/artifact-collaborators";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { withDb } from "@repo/database";
import { keys } from "@repo/database/keys";
import { afterEach, describe, expect, it } from "vitest";
import {
  createCommittedTestOrganizationTracker,
  createTestUser,
} from "@/__tests__/utils/db-helpers";
import { artifactCollaboratorsService } from "./service";

const tracker = createCommittedTestOrganizationTracker();

describe.skipIf(!keys().DATABASE_URL)("legacy markdown participation", () => {
  afterEach(() => tracker.cleanup());

  it("retains version authors without claiming complete historical interactions", async () => {
    const organizationId = await tracker.create();
    const creator = await createTestUser(organizationId);
    const versionAuthor = await createTestUser(organizationId);
    const artifact = await withDb((db) =>
      db.artifact.create({
        data: {
          organizationId,
          type: ArtifactType.Document,
          name: "Legacy body",
          status: "test",
          createdById: creator.id,
          document: {
            create: {
              repositorySnapshot: {},
              versions: {
                create: { version: 1, createdById: versionAuthor.id },
              },
            },
          },
        },
        select: { id: true },
      })
    );
    const result = await artifactCollaboratorsService.readBatch(
      organizationId,
      {
        artifactType: ArtifactType.Document,
        artifactIds: [artifact.id],
      }
    );
    const entry = result.results[0];
    expect(
      entry.collaborators.people.map((person) => person.userId).sort()
    ).toEqual([creator.id, versionAuthor.id].sort());
    expect(
      entry.collaborators.sources[DirectCollaboratorSource.Interactions]
    ).toBe(BranchIdentityAvailability.Incomplete);
    expect(entry.commentCount).toBe(0);
  });
});
