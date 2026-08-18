import type { CustomFieldValueDetail } from "@repo/api/src/types/custom-field";
import {
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_LIST_MAX_RECENCY_DAYS,
  DOCUMENT_LIST_MIN_RECENCY_DAYS,
  DocumentListRecency,
  DocumentType,
  DocumentTypeInput,
  type DocumentWithProject,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import { ProjectStatus } from "@repo/api/src/types/project";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  attachCustomFieldValues,
  buildArchivedProjectFilter,
  buildDocumentListWhere,
  buildRecencyFilter,
  resolveDocumentListHasMore,
  resolveDocumentListRecencyDays,
  resolveDocumentListSkip,
  resolveDocumentListTake,
} from "../document-list-query";

// FEA-4373: the document-list bound is opt-in and clamped. These pure helpers
// own that policy; the service just applies their results as Prisma take/skip.
describe("resolveDocumentListTake", () => {
  it("returns undefined (unbounded) when no limit is supplied", () => {
    expect(resolveDocumentListTake(undefined)).toBeUndefined();
  });

  it("passes a valid limit straight through", () => {
    expect(resolveDocumentListTake(50)).toBe(50);
  });

  it("clamps a limit above the ceiling to DOCUMENT_LIST_MAX_LIMIT", () => {
    expect(resolveDocumentListTake(10_000)).toBe(DOCUMENT_LIST_MAX_LIMIT);
  });

  it("floors a non-positive limit to 1", () => {
    expect(resolveDocumentListTake(0)).toBe(1);
    expect(resolveDocumentListTake(-5)).toBe(1);
  });
});

describe("resolveDocumentListSkip", () => {
  it("returns undefined when the query is unbounded (no take)", () => {
    expect(resolveDocumentListSkip(undefined, 100)).toBeUndefined();
  });

  it("defaults to 0 when a take is present but no offset is supplied", () => {
    expect(resolveDocumentListSkip(200, undefined)).toBe(0);
  });

  it("passes a valid offset straight through alongside a take", () => {
    expect(resolveDocumentListSkip(200, 100)).toBe(100);
  });

  it("clamps an offset above the ceiling to DOCUMENT_LIST_MAX_OFFSET", () => {
    expect(resolveDocumentListSkip(200, 1_000_000)).toBe(
      DOCUMENT_LIST_MAX_OFFSET
    );
  });

  it("floors a negative offset to 0", () => {
    expect(resolveDocumentListSkip(200, -10)).toBe(0);
  });
});

// ISS-4576: the paged findMany and the honest-total count are built from THIS
// one predicate. A count over a drifted predicate would report a total for a
// population the page was never drawn from.
describe("buildDocumentListWhere", () => {
  const ORG_ID = "org-1";

  it("always scopes to the organization and the DOCUMENT artifact type", () => {
    const where = buildDocumentListWhere({ organizationId: ORG_ID });

    expect(where).toMatchObject({ organizationId: ORG_ID });
    expect(where.type).toBeDefined();
  });

  it("omits an unrequested filter entirely rather than matching on undefined", () => {
    const where = buildDocumentListWhere({ organizationId: ORG_ID });

    expect(where).not.toHaveProperty("assigneeId");
    expect(where).not.toHaveProperty("subtype");
    expect(where).not.toHaveProperty("projectId");
  });

  it("applies the assignee filter the My Tasks board pages by", () => {
    const where = buildDocumentListWhere({
      organizationId: ORG_ID,
      assigneeId: "user-1",
    });

    expect(where).toMatchObject({ assigneeId: "user-1" });
  });

  it("normalizes the ISSUE type alias to the persisted FEATURE subtype (ISS-4397)", () => {
    const where = buildDocumentListWhere({
      organizationId: ORG_ID,
      type: DocumentTypeInput.Issue,
    });

    expect(where).toMatchObject({ subtype: DocumentType.Feature });
  });

  it("lets a concrete projectId win over the unassignedProject narrowing (FEA-4140)", () => {
    const where = buildDocumentListWhere({
      organizationId: ORG_ID,
      projectId: "project-1",
      unassignedProject: true,
    });

    expect(where).toMatchObject({ projectId: "project-1" });
  });

  it("narrows to project-less documents when only unassignedProject is set", () => {
    const where = buildDocumentListWhere({
      organizationId: ORG_ID,
      unassignedProject: true,
    });

    expect(where).toMatchObject({ projectId: null });
  });
});

describe("resolveDocumentListHasMore", () => {
  it("reports more when rows remain past this page", () => {
    expect(resolveDocumentListHasMore(0, 50, 137)).toBe(true);
  });

  it("reports no more once the page reaches the total", () => {
    expect(resolveDocumentListHasMore(100, 37, 137)).toBe(false);
  });

  it("does not claim a phantom next page when the LAST page fills exactly", () => {
    // The `pageSize === items.length` heuristic this replaces would say true.
    expect(resolveDocumentListHasMore(50, 50, 100)).toBe(false);
  });

  it("reports no more for an empty result set", () => {
    expect(resolveDocumentListHasMore(0, 0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// FEA-1626 (epic FEA-908): recency + lifecycle defaults on the user-scoped arm
// ---------------------------------------------------------------------------

const ORGANIZATION_ID = "org-1";
const USER_ID = "user-1";
const FIXED_NOW = new Date("2026-08-05T12:00:00.000Z");
const DAY_MS = 86_400_000;

/** A request shaped like the My Tasks board's: user-scoped AND paged. */
function userScopedPagedOptions(
  overrides: Partial<FindDocumentsOptions> = {}
): FindDocumentsOptions & { organizationId: string } {
  return {
    organizationId: ORGANIZATION_ID,
    assigneeId: USER_ID,
    limit: 50,
    ...overrides,
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(FIXED_NOW);
});

afterEach(() => {
  vi.useRealTimers();
});

describe("resolveDocumentListRecencyDays", () => {
  it("applies NO window when the caller omits the param — omission is legacy", () => {
    // The polarity that matters (wongk): an already-deployed old app sends
    // exactly this request. If omission meant "90 days", that app's response
    // would narrow the moment this API deployed, ahead of any client flag.
    expect(
      resolveDocumentListRecencyDays(userScopedPagedOptions())
    ).toBeUndefined();
  });

  it("applies NO window to a bare request either", () => {
    expect(resolveDocumentListRecencyDays({})).toBeUndefined();
  });

  it("treats the explicit all sentinel the same as omission", () => {
    expect(
      resolveDocumentListRecencyDays(
        userScopedPagedOptions({ recencyDays: DocumentListRecency.All })
      )
    ).toBeUndefined();
  });

  it("windows only when a day count is explicitly requested", () => {
    expect(
      resolveDocumentListRecencyDays(
        userScopedPagedOptions({
          recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
        })
      )
    ).toBe(DOCUMENT_LIST_DEFAULT_RECENCY_DAYS);
  });

  it("honors an explicit window off the user-scoped arm too", () => {
    expect(resolveDocumentListRecencyDays({ recencyDays: 7 })).toBe(7);
  });

  it("clamps an over-large window to the ceiling", () => {
    expect(resolveDocumentListRecencyDays({ recencyDays: 1_000_000 })).toBe(
      DOCUMENT_LIST_MAX_RECENCY_DAYS
    );
  });

  it("floors a zero or negative window rather than letting Math.min pass it through", () => {
    expect(resolveDocumentListRecencyDays({ recencyDays: 0 })).toBe(
      DOCUMENT_LIST_MIN_RECENCY_DAYS
    );
    expect(resolveDocumentListRecencyDays({ recencyDays: -30 })).toBe(
      DOCUMENT_LIST_MIN_RECENCY_DAYS
    );
  });
});

describe("buildRecencyFilter", () => {
  it("windows on updatedAt, measured back from now, when asked to", () => {
    expect(
      buildRecencyFilter(
        { recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS },
        FIXED_NOW
      )
    ).toEqual({
      updatedAt: {
        gte: new Date(
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS
        ),
      },
    });
  });

  it("emits nothing at all when the caller asked for no window", () => {
    expect(buildRecencyFilter({}, FIXED_NOW)).toEqual({});
  });
});

// The archived-project filter is where a NULL genuinely IS reachable:
// `Artifact.projectId` is nullable for every artifact type, so a bare
// `project: { status: { not: ARCHIVED } }` relation filter would drop every
// org-level Document and Template. These tests pin that a project-less artifact
// reads as "not archived" rather than "unknown, therefore excluded".
describe("buildArchivedProjectFilter", () => {
  it("keeps project-less artifacts alongside non-archived projects when asked to exclude", () => {
    expect(
      buildArchivedProjectFilter({ includeArchivedProjects: false })
    ).toEqual({
      OR: [
        { projectId: null },
        { project: { status: { not: ProjectStatus.Archived } } },
      ],
    });
  });

  it("emits nothing when the param is omitted — omission keeps archived rows", () => {
    expect(buildArchivedProjectFilter(userScopedPagedOptions())).toEqual({});
  });

  it("emits nothing when the caller explicitly opts archived projects back in", () => {
    expect(
      buildArchivedProjectFilter({ includeArchivedProjects: true })
    ).toEqual({});
  });

  it("does not second-guess an explicitly requested project", () => {
    expect(
      buildArchivedProjectFilter({
        includeArchivedProjects: false,
        projectId: "project-1",
      })
    ).toEqual({});
  });
});

describe("buildDocumentListWhere (FEA-1626 opt-in narrowing)", () => {
  it("applies both narrowings when the client asks for both", () => {
    const where = buildDocumentListWhere(
      userScopedPagedOptions({
        recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
        includeArchivedProjects: false,
      }),
      FIXED_NOW
    );

    expect(where).toMatchObject({
      assigneeId: USER_ID,
      updatedAt: {
        gte: new Date(
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS
        ),
      },
      OR: [
        { projectId: null },
        { project: { status: { not: ProjectStatus.Archived } } },
      ],
    });
  });

  it("leaves the SAME user-scoped, paged request unnarrowed when the params are omitted", () => {
    // The version-skew case that decides the whole design: this shape is
    // exactly what an already-deployed old `apps/app` build sends, and what a
    // new build sends with the flag off. It must read as full history.
    const where = buildDocumentListWhere(userScopedPagedOptions(), FIXED_NOW);

    expect(where).not.toHaveProperty("updatedAt");
    expect(where).not.toHaveProperty("OR");
  });

  it("leaves every other consumer's predicate byte-identical to before", () => {
    // The Documents index, plan/document pickers, the MCP `list-documents`
    // tool, and version-skewed API-key clients all read unbounded.
    const where = buildDocumentListWhere(
      { organizationId: ORGANIZATION_ID, assigneeId: USER_ID },
      FIXED_NOW
    );

    expect(where).not.toHaveProperty("updatedAt");
    expect(where).not.toHaveProperty("OR");
  });

  it("returns to full history when the caller explicitly requests older data", () => {
    const where = buildDocumentListWhere(
      userScopedPagedOptions({
        recencyDays: DocumentListRecency.All,
        includeArchivedProjects: true,
      }),
      FIXED_NOW
    );

    expect(where).not.toHaveProperty("updatedAt");
    expect(where).not.toHaveProperty("OR");
  });

  it("defaults from the ambient clock when no instant is supplied", () => {
    const where = buildDocumentListWhere(
      userScopedPagedOptions({
        recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
      })
    );

    expect(where).toMatchObject({
      updatedAt: {
        gte: new Date(
          FIXED_NOW.getTime() - DOCUMENT_LIST_DEFAULT_RECENCY_DAYS * DAY_MS
        ),
      },
    });
  });
});

// Extracted out of the grandfathered `document-service.ts` alongside FEA-1626's
// predicate work. Pure list-shaping, so it is covered here rather than through
// the service that reads the values.
describe("attachCustomFieldValues", () => {
  const documents = [
    { id: "doc-1" },
    { id: "doc-2" },
  ] as unknown as DocumentWithProject[];

  it("groups a flat batch read onto the row each value belongs to", () => {
    const values = [
      { entityId: "doc-1", fieldId: "f1" },
      { entityId: "doc-2", fieldId: "f2" },
      { entityId: "doc-1", fieldId: "f3" },
    ] as unknown as CustomFieldValueDetail[];

    const attached = attachCustomFieldValues(documents, values);

    expect(attached[0]?.customFields).toEqual([values[0], values[2]]);
    expect(attached[1]?.customFields).toEqual([values[1]]);
  });

  it("gives a document with no values an empty array, never undefined", () => {
    const attached = attachCustomFieldValues(documents, []);

    expect(attached[0]?.customFields).toEqual([]);
    expect(attached[1]?.customFields).toEqual([]);
  });
});
