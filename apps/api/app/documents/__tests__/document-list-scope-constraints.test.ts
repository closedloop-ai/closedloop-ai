/**
 * ISS-12600 — the owner, tag and favorite conjuncts of `buildDocumentListWhere`.
 * Each enters its own `AND` element, so none may clobber the search slice's
 * conjunct, the archived-project `OR`, or the scalar "mine" `assigneeId`.
 */
import { describe, expect, it } from "vitest";
import {
  type FixtureRow,
  matchesWhere,
} from "@/__tests__/support/documents/prisma-where.test-db";
import {
  buildDocumentListWhere,
  buildScopeConstraintConjuncts,
} from "../document-list-query";

const ORG = "org-1";
const ME = "user-me";
const OTHER = "user-other";

function row(overrides: Partial<FixtureRow>): FixtureRow {
  return {
    id: "a",
    organizationId: ORG,
    type: "DOCUMENT",
    assigneeId: ME,
    name: "Roadmap",
    slug: "DOC-1",
    projectId: null,
    project: null,
    tagArtifacts: [{ tagId: "tag-1" }],
    favoritedBy: [{ userId: ME }],
    ...overrides,
  };
}

describe("buildScopeConstraintConjuncts", () => {
  it("emits nothing when no metric filter is set, leaving the list shape untouched", () => {
    expect(buildScopeConstraintConjuncts({})).toEqual([]);
    expect(
      buildDocumentListWhere({ organizationId: ORG, search: "road" })
    ).toEqual(
      buildDocumentListWhere({
        organizationId: ORG,
        search: "road",
        assigneeIds: [],
        tagIds: [],
      })
    );
  });

  it("ORs listed owners with Unassigned, dedupes sets, and binds favorites to the caller", () => {
    expect(
      buildScopeConstraintConjuncts({
        assigneeIds: [OTHER, OTHER],
        includeUnassigned: true,
        tagIds: ["tag-1", "tag-1"],
        favoritedByUserId: ME,
      })
    ).toEqual([
      { OR: [{ assigneeId: { in: [OTHER] } }, { assigneeId: null }] },
      { tagArtifacts: { some: { tagId: { in: ["tag-1"] } } } },
      { favoritedBy: { some: { userId: ME } } },
    ]);
  });
});

describe("buildDocumentListWhere with metric filters", () => {
  const where = buildDocumentListWhere({
    organizationId: ORG,
    search: "road",
    assigneeId: ME,
    assigneeIds: [ME, OTHER],
    tagIds: ["tag-1"],
    favoritedByUserId: ME,
    includeArchivedProjects: false,
  });

  it("keeps search, archived-project, mine and every facet in force together", () => {
    expect(matchesWhere(row({}), where)).toBe(true);
    for (const miss of [
      { name: "Other", slug: "DOC-2" },
      { assigneeId: OTHER },
      { tagArtifacts: [{ tagId: "tag-2" }] },
      { favoritedBy: [{ userId: OTHER }] },
      { organizationId: "org-2" },
      { projectId: "p", project: { status: "ARCHIVED" } },
    ]) {
      expect(matchesWhere(row(miss), where)).toBe(false);
    }
  });

  it("matches an unowned artifact only when Unassigned is selected", () => {
    const unowned = row({ assigneeId: null });
    expect(
      matchesWhere(
        unowned,
        buildDocumentListWhere({ organizationId: ORG, assigneeIds: [OTHER] })
      )
    ).toBe(false);
    expect(
      matchesWhere(
        unowned,
        buildDocumentListWhere({
          organizationId: ORG,
          assigneeIds: [OTHER],
          includeUnassigned: true,
        })
      )
    ).toBe(true);
  });
});
