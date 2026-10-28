import type { Artifact } from "@repo/api/src/types/artifact";
import { Priority } from "@repo/api/src/types/common";
import {
  type ArtifactStatus,
  DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
  DOCUMENT_LIST_MAX_LIMIT,
  DOCUMENT_LIST_MAX_OFFSET,
  DocumentListRecency,
  DocumentStatus,
  DocumentType,
  type DocumentWithProject,
  type FindDocumentsOptions,
} from "@repo/api/src/types/document";
import type { DocumentRowItem } from "@repo/app/documents/components/table/document-row";
import { describe, expect, test, vi } from "vitest";
import {
  applyClientFilters,
  buildArtifactListParams,
  EMPTY_FILTERS,
  hasActiveFilters,
  resolveRecencyParams,
  selectKanbanArtifacts,
} from "../utils";

describe("buildArtifactListParams", () => {
  test("scopes to the assignee and forwards the requested server page (ISS-4576)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: 100,
    });
    const expected: Omit<FindDocumentsOptions, "includeTotal"> = {
      assigneeId: "user-123",
      limit: 50,
      offset: 100,
    };
    expect(params).toEqual(expected);
    expect(params).not.toHaveProperty("type");
  });

  test("returns undefined assigneeId (unfetchable) when input is null but stays bounded", () => {
    const params = buildArtifactListParams(null, {
      limit: DOCUMENT_LIST_MAX_LIMIT,
      offset: 0,
    });
    const expected: Omit<FindDocumentsOptions, "includeTotal"> = {
      assigneeId: undefined,
      limit: DOCUMENT_LIST_MAX_LIMIT,
      offset: 0,
    };
    expect(params).toEqual(expected);
    expect(params).not.toHaveProperty("type");
  });

  test("clamps a limit above the endpoint ceiling down to DOCUMENT_LIST_MAX_LIMIT", () => {
    const params = buildArtifactListParams("user-123", {
      limit: DOCUMENT_LIST_MAX_LIMIT * 10,
      offset: 0,
    });
    expect(params.limit).toBe(DOCUMENT_LIST_MAX_LIMIT);
  });

  test("floors a non-positive limit at 1 and a negative offset at 0 (Math.min alone would not)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 0,
      offset: -25,
    });
    expect(params.limit).toBe(1);
    expect(params.offset).toBe(0);
  });

  test("caps an offset above the endpoint ceiling to DOCUMENT_LIST_MAX_OFFSET so the read never 400s (codex P2)", () => {
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: DOCUMENT_LIST_MAX_OFFSET + 50,
    });
    expect(params.offset).toBe(DOCUMENT_LIST_MAX_OFFSET);
  });

  test("sends NEITHER narrowing param while the FEA-1626 flag is off", () => {
    // Closed-by-default (ISS-4779) AND deploy-skew safety (whitlockk): the flag-off
    // request must be byte-identical to what this board sent before FEA-1626,
    // so it stays valid against an API that has not deployed the new params and
    // reads full history against one that has.
    const params = buildArtifactListParams("user-123", {
      limit: 50,
      offset: 0,
    });

    expect(params).not.toHaveProperty("recencyDays");
    expect(params).not.toHaveProperty("includeArchivedProjects");
  });

  test("asks for BOTH narrowings explicitly once the FEA-1626 flag is on", () => {
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      true
    );

    // Opting IN is what the flag does: the server applies nothing on its own, so
    // an omitted param here would ship the flag with no perceivable effect.
    expect(params.recencyDays).toBe(DOCUMENT_LIST_DEFAULT_RECENCY_DAYS);
    expect(params.includeArchivedProjects).toBe(false);
  });

  test("drops the window on the wire when the user removes the recency chip", () => {
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      true,
      true
    );

    expect(params.recencyDays).toBe(DocumentListRecency.All);
    expect(params.includeArchivedProjects).toBe(true);
  });

  test("keeps the chip's removal inert while the flag is off", () => {
    // No window is in force, so there is nothing to remove and nothing to say
    // on the wire — the request must not start carrying params the flag-off
    // path never sent.
    const params = buildArtifactListParams(
      "user-123",
      { limit: 50, offset: 0 },
      false,
      true
    );

    expect(params).not.toHaveProperty("recencyDays");
    expect(params).not.toHaveProperty("includeArchivedProjects");
  });
});

describe("applyClientFilters", () => {
  function makeArtifact(
    id: string,
    overrides: {
      projectId?: string | null;
      status?: ArtifactStatus;
      priority?: Priority;
    } = {}
  ): DocumentWithProject {
    return {
      id,
      projectId: overrides.projectId ?? null,
      status: overrides.status ?? DocumentStatus.Draft,
      priority: overrides.priority ?? Priority.Medium,
    } as unknown as DocumentWithProject;
  }

  test("returns every artifact when no filters are active", () => {
    const artifacts = [makeArtifact("1"), makeArtifact("2")];

    expect(applyClientFilters(artifacts, EMPTY_FILTERS)).toEqual(artifacts);
  });

  test("keeps only artifacts whose projectId matches the projectIds filter", () => {
    const inProject = makeArtifact("1", { projectId: "proj-a" });
    const otherProject = makeArtifact("2", { projectId: "proj-b" });

    const filtered = applyClientFilters([inProject, otherProject], {
      ...EMPTY_FILTERS,
      projectIds: ["proj-a"],
    });

    expect(filtered).toEqual([inProject]);
  });

  test("excludes an artifact with a null projectId when the projectIds filter is active", () => {
    const unassignedToProject = makeArtifact("1", { projectId: null });

    const filtered = applyClientFilters([unassignedToProject], {
      ...EMPTY_FILTERS,
      projectIds: ["proj-a"],
    });

    expect(filtered).toEqual([]);
  });

  test("keeps only artifacts whose status matches the statuses filter", () => {
    const inReview = makeArtifact("1", { status: DocumentStatus.InReview });
    const draft = makeArtifact("2", { status: DocumentStatus.Draft });

    const filtered = applyClientFilters([inReview, draft], {
      ...EMPTY_FILTERS,
      statuses: [DocumentStatus.InReview],
    });

    expect(filtered).toEqual([inReview]);
  });

  test("keeps only artifacts whose priority matches the priorities filter", () => {
    const urgent = makeArtifact("1", { priority: Priority.Urgent });
    const low = makeArtifact("2", { priority: Priority.Low });

    const filtered = applyClientFilters([urgent, low], {
      ...EMPTY_FILTERS,
      priorities: [Priority.Urgent],
    });

    expect(filtered).toEqual([urgent]);
  });

  test("combines projectIds, statuses, and priorities filters with AND logic", () => {
    const matchesAll = makeArtifact("1", {
      projectId: "proj-a",
      status: DocumentStatus.InReview,
      priority: Priority.Urgent,
    });
    const matchesProjectOnly = makeArtifact("2", {
      projectId: "proj-a",
      status: DocumentStatus.Draft,
      priority: Priority.Urgent,
    });

    const filtered = applyClientFilters([matchesAll, matchesProjectOnly], {
      projectIds: ["proj-a"],
      statuses: [DocumentStatus.InReview],
      priorities: [Priority.Urgent],
    });

    expect(filtered).toEqual([matchesAll]);
  });

  test("returns an empty array when the artifacts list is empty", () => {
    const filtered = applyClientFilters([], {
      ...EMPTY_FILTERS,
      projectIds: ["proj-a"],
    });

    expect(filtered).toEqual([]);
  });
});

describe("hasActiveFilters", () => {
  test("returns false when every filter is empty", () => {
    expect(hasActiveFilters(EMPTY_FILTERS)).toBe(false);
  });

  test("returns true when projectIds is non-empty", () => {
    expect(hasActiveFilters({ ...EMPTY_FILTERS, projectIds: ["proj-a"] })).toBe(
      true
    );
  });

  test("returns true when statuses is non-empty", () => {
    expect(
      hasActiveFilters({ ...EMPTY_FILTERS, statuses: [DocumentStatus.Draft] })
    ).toBe(true);
  });

  test("returns true when priorities is non-empty", () => {
    expect(
      hasActiveFilters({ ...EMPTY_FILTERS, priorities: [Priority.Urgent] })
    ).toBe(true);
  });
});

describe("selectKanbanArtifacts", () => {
  function makeDocRow(
    id: string,
    overrides: { title?: string; slug?: string; type?: DocumentType } = {}
  ): DocumentRowItem {
    return {
      kind: "document",
      data: {
        id,
        title: overrides.title ?? `Artifact ${id}`,
        slug: overrides.slug ?? `art-${id}`,
        type: overrides.type ?? DocumentType.Prd,
        status: DocumentStatus.Draft,
        priority: Priority.Medium,
        assigneeId: null,
        assignee: null,
      } as unknown as DocumentWithProject,
    };
  }

  function makeBranchRow(id: string): DocumentRowItem {
    return {
      kind: "branch",
      data: { id } as unknown as Artifact,
    };
  }

  test("returns no rows when rootItems is empty", () => {
    const result = selectKanbanArtifacts({
      rootItems: [],
      filterText: "",
      isAnyFilterActive: false,
      applyFilters: (items) => items,
    });

    expect(result).toEqual([]);
  });

  test("excludes non-document row kinds before searching or filtering", () => {
    const branchRow = makeBranchRow("b1");
    const docRow = makeDocRow("1");

    const result = selectKanbanArtifacts({
      rootItems: [branchRow, docRow],
      filterText: "",
      isAnyFilterActive: false,
      applyFilters: (items) => items,
    });

    expect(result).toEqual([docRow.data]);
  });

  test("narrows results to documents whose title or slug match the filter text", () => {
    const onboarding = makeDocRow("1", { title: "Onboarding flow" });
    const billing = makeDocRow("2", { title: "Billing dashboard" });

    const result = selectKanbanArtifacts({
      rootItems: [onboarding, billing],
      filterText: "onboard",
      isAnyFilterActive: false,
      applyFilters: (items) => items,
    });

    expect(result).toEqual([onboarding.data]);
  });

  test("passes the searched items through applyFilters and uses only what it returns", () => {
    const kept = makeDocRow("1");
    const dropped = makeDocRow("2");
    const applyFilters = vi.fn((items: DocumentRowItem[]) =>
      items.filter((item) => item.data.id === kept.data.id)
    );

    const result = selectKanbanArtifacts({
      rootItems: [kept, dropped],
      filterText: "",
      isAnyFilterActive: true,
      applyFilters,
    });

    expect(applyFilters).toHaveBeenCalledWith([kept, dropped]);
    expect(result).toEqual([kept.data]);
  });

  test("drops document rows whose type is not navigable", () => {
    const template = makeDocRow("1", { type: DocumentType.Template });
    const prd = makeDocRow("2", { type: DocumentType.Prd });

    const result = selectKanbanArtifacts({
      rootItems: [template, prd],
      filterText: "",
      isAnyFilterActive: false,
      applyFilters: (items) => items,
    });

    expect(result).toEqual([prd.data]);
  });
});

describe("resolveRecencyParams", () => {
  test("omits both params when the recency window flag is off", () => {
    expect(resolveRecencyParams(false, false)).toEqual({});
  });

  test("requests the default recency window when the flag is on and the window is kept", () => {
    expect(resolveRecencyParams(true, false)).toEqual({
      recencyDays: DOCUMENT_LIST_DEFAULT_RECENCY_DAYS,
      includeArchivedProjects: false,
    });
  });

  test("requests full history explicitly when the flag is on and the user removes the window", () => {
    expect(resolveRecencyParams(true, true)).toEqual({
      recencyDays: DocumentListRecency.All,
      includeArchivedProjects: true,
    });
  });
});
