import { ArtifactType } from "@repo/api/src/types/artifact";
import { BranchIdentityAvailability } from "@repo/api/src/types/branch-identity";
import { DocumentType } from "@repo/api/src/types/document";
import { describe, expect, it } from "vitest";
import { makeBranchRow } from "@/__tests__/support/branches/branch-read-service.test-helpers";
import {
  projectCanonicalCloudBranchDetail,
  projectCanonicalCloudBranchRow,
  projectCloudBranchRefreshDetail,
} from "./canonical-projection";

/**
 * ISS-12197: the Branch detail's generic Artifact-row fields and its parent.
 * Both detail entry points share `projectCloudBranchDetail`, so the refresh
 * compatibility row is pinned beside the canonical one.
 */

const ORGANIZATION_ID = "11111111-1111-4111-8111-111111111111";
const ASSIGNEE = {
  id: "user-assignee",
  email: "assignee@example.com",
  firstName: "Grace",
  lastName: "Hopper",
  avatarUrl: "https://a.test/grace.png",
};
const ASSIGNEE_ROW = { ...ASSIGNEE, organizationId: ORGANIZATION_ID };
const CREATOR = {
  id: "user-creator",
  email: "creator@example.com",
  firstName: "Alan",
  lastName: "Turing",
  avatarUrl: null,
};
const UPDATED_AT = new Date("2026-08-11T00:00:00.000Z");
const DUE_DATE = new Date("2026-09-01T00:00:00.000Z");

function producesLink(id: string, slug: string, createdAt: Date) {
  return {
    id,
    createdAt,
    source: {
      id: `artifact-${id}`,
      type: ArtifactType.Document,
      subtype: DocumentType.Feature,
      name: `Issue ${slug}`,
      slug,
      externalUrl: null,
    },
  };
}

describe("the detail's Artifact row fields (ISS-12197)", () => {
  it("serves the row's slug, assignee, creator, timestamps, due date and project name", () => {
    const row = makeBranchRow({
      slug: "BR-0001",
      updatedAt: UPDATED_AT,
      dueDate: DUE_DATE,
      assignee: ASSIGNEE_ROW,
      createdBy: CREATOR,
      project: { name: "Agent Platform" },
    });

    const detail = projectCanonicalCloudBranchDetail(row, ORGANIZATION_ID);

    expect(detail.slug).toBe("BR-0001");
    expect(detail.assignee).toEqual(ASSIGNEE);
    expect(detail.createdBy).toEqual(CREATOR);
    expect(detail.createdAt).toBe(row.createdAt.toISOString());
    expect(detail.updatedAt).toBe(UPDATED_AT.toISOString());
    expect(detail.dueDate).toBe(DUE_DATE.toISOString());
    expect(detail.projectName).toBe("Agent Platform");
  });

  it("serves the assignee as the Owner when no identity read ran (ISS-12463)", () => {
    const row = makeBranchRow({ assignee: ASSIGNEE_ROW });

    const detail = projectCanonicalCloudBranchDetail(row, ORGANIZATION_ID);
    const listRow = projectCanonicalCloudBranchRow(row, ORGANIZATION_ID);

    expect(detail.owner).toBe("Grace Hopper");
    expect(detail.ownerIdentity?.person?.userId).toBe(ASSIGNEE.id);
    expect(listRow.ownerIdentity).toEqual(detail.ownerIdentity);
  });

  it("names no Owner for an assignee outside the branch's organization", () => {
    const row = makeBranchRow({
      assignee: { ...ASSIGNEE, organizationId: "other-organization" },
    });

    expect(
      projectCanonicalCloudBranchRow(row, ORGANIZATION_ID).ownerIdentity
    ).toEqual({
      availability: BranchIdentityAvailability.Complete,
      person: null,
    });
  });

  it("serves explicit nulls for a row with no assignee, creator, due date or project, and no Owner", () => {
    const row = makeBranchRow();

    const detail = projectCanonicalCloudBranchDetail(row, ORGANIZATION_ID);

    expect(detail).toHaveProperty("assignee", null);
    expect(detail).toHaveProperty("createdBy", null);
    expect(detail).toHaveProperty("dueDate", null);
    expect(detail).toHaveProperty("projectName", null);
    expect(detail).toHaveProperty("slug", null);
    expect(detail.owner).toBeNull();
  });

  it("names the earliest inbound PRODUCES source as the parent", () => {
    const detail = projectCanonicalCloudBranchDetail(
      makeBranchRow({
        targetLinks: [
          producesLink("link-1", "ISS-0004", new Date("2026-08-01")),
          producesLink("link-2", "ISS-0005", new Date("2026-08-02")),
        ],
      }),
      ORGANIZATION_ID
    );

    expect(detail.parent).toEqual({
      id: "artifact-link-1",
      name: "Issue ISS-0004",
      slug: "ISS-0004",
      type: ArtifactType.Document,
      documentType: DocumentType.Feature,
    });
  });

  it("serves parent as null when nothing PRODUCES the branch", () => {
    const detail = projectCanonicalCloudBranchDetail(
      makeBranchRow({ targetLinks: [] }),
      ORGANIZATION_ID
    );

    expect(detail).toHaveProperty("parent", null);
  });

  it("carries the same fields on the refresh compatibility detail", () => {
    const detail = projectCloudBranchRefreshDetail(
      makeBranchRow({
        assignee: ASSIGNEE_ROW,
        targetLinks: [
          producesLink("link-1", "ISS-0004", new Date("2026-08-01")),
        ],
      }),
      ORGANIZATION_ID
    );

    expect(detail.assignee).toEqual(ASSIGNEE);
    expect(detail.parent?.slug).toBe("ISS-0004");
  });
});
