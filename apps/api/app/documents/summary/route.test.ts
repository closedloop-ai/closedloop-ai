/**
 * ISS-8936 — `GET /documents/summary` at the ROUTE, not at its service.
 *
 * The service suite mocks `withDb` and asserts predicates; nothing in it runs
 * this handler, so the three decisions the handler alone makes were unpinned
 * (review thread on #8000): the project-404 branch, the repeated-`status` fold
 * that `Object.fromEntries` would silently collapse, and the `.strict()` refusal
 * of a paging or custom-field sort key.
 */
import {
  CustomFieldFilterOperator,
  CustomFieldQueryRejection,
} from "@repo/api/src/types/custom-field-list-query";
import { DocumentType, IssueStatus } from "@repo/api/src/types/document";
import {
  DOCUMENT_SUMMARY_ID_BATCH_SIZE,
  type DocumentListSummary,
} from "@repo/api/src/types/document-list-summary";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRequest,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockSummarize = vi.hoisted(() => vi.fn());

vi.mock("@/app/documents/document-summary-service", () => ({
  documentSummaryService: { summarizeScope: mockSummarize },
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (auth: AuthContext, request: Request) => unknown) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  return { ...actual, resolveProjectId: vi.fn() };
});

import { resolveProjectId } from "@/lib/identifier-utils";
import { GET } from "./route";

const UUID_A = "00000000-0000-4000-8000-0000000000a1";
const UUID_B = "00000000-0000-4000-8000-0000000000b1";

const SUMMARY: DocumentListSummary = {
  total: 41,
  producedByAgentSessions: 17,
  updatedInWindow: 9,
  neverEdited: 5,
  windowDays: 7,
};

function getSummary(url: string) {
  return GET(createMockRequest({ url }), {
    params: Promise.resolve({}),
  } as never);
}

// Module level so the cases outside the describe get a settled service too:
// this suite runs with `mockReset`, which clears implementations per test.
beforeEach(() => {
  mockAuthContext = createTestAuthContext();
  mockSummarize.mockResolvedValue({ ok: true, value: SUMMARY });
});

describe("GET /documents/summary", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
    mockSummarize.mockResolvedValue({ ok: true, value: SUMMARY });
    vi.mocked(resolveProjectId).mockImplementation(async (id: string) => id);
  });

  it("forwards every subtype in the combined summary population", async () => {
    const types = [
      DocumentType.Prd,
      DocumentType.ImplementationPlan,
      DocumentType.Doc,
    ];
    const query = new URLSearchParams();
    for (const type of types) {
      query.append("types", type);
    }
    const response = await getSummary(
      `http://localhost:3002/documents/summary?${query}`
    );
    expect(response.status).toBe(200);
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ types }),
      mockAuthContext.user.id
    );
  });

  it("forwards the index filter and org-scopes the query", async () => {
    const response = await getSummary(
      "http://localhost:3002/documents/summary?type=DOC&unassignedProject=true"
    );

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({ data: SUMMARY });
    expect(mockSummarize).toHaveBeenCalledWith(
      {
        organizationId: mockAuthContext.user.organizationId,
        projectId: undefined,
        type: DocumentType.Doc,
        unassignedProject: true,
      },
      mockAuthContext.user.id
    );
  });

  it("keeps EVERY status a caller repeated, not just the last", async () => {
    // `Object.fromEntries(searchParams.entries())` keeps the last occurrence
    // only, so without the `getAll` fold this summarizes DONE alone — a filter
    // the caller asked for, dropped without a word.
    await getSummary(
      `http://localhost:3002/documents/summary?status=${IssueStatus.Todo}&status=${IssueStatus.Done}`
    );

    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({
        status: [IssueStatus.Todo, IssueStatus.Done],
      }),
      mockAuthContext.user.id
    );
  });

  it("404s a project the caller cannot resolve rather than summarizing the org", async () => {
    vi.mocked(resolveProjectId).mockResolvedValue(null);

    const response = await getSummary(
      "http://localhost:3002/documents/summary?projectId=PRD-42"
    );

    expect(response.status).toBe(404);
    expect(mockSummarize).not.toHaveBeenCalled();
  });

  it("resolves a project identifier to its id before counting", async () => {
    vi.mocked(resolveProjectId).mockResolvedValue("project-uuid");

    const response = await getSummary(
      "http://localhost:3002/documents/summary?projectId=PRD-42"
    );

    expect(response.status).toBe(200);
    expect(mockSummarize).toHaveBeenCalledWith(
      expect.objectContaining({ projectId: "project-uuid" }),
      mockAuthContext.user.id
    );
  });

  it.each([
    ["limit", "limit=10"],
    ["offset", "offset=10"],
    ["customFieldSortId", `customFieldSortId=${UUID_A}`],
    ["an unknown owner key", `ownerIds=${UUID_A}`],
    ["a non-literal favorites flag", "favoritesOnly=yes"],
    ["a malformed owner id", "assigneeIds=not-a-uuid"],
  ])(
    "400s on %s rather than summarizing a different population",
    async (_key, query) => {
      const response = await getSummary(
        `http://localhost:3002/documents/summary?${query}`
      );

      expect(response.status).toBe(400);
      expect(mockSummarize).not.toHaveBeenCalled();
    }
  );
});

// ISS-12600: the card scope's owner, tag, favorite and custom-field filters.
it("forwards repeated owner and tag facets, favorites and custom-field facets with the caller", async () => {
  const facets = [
    {
      fieldId: UUID_A,
      operator: CustomFieldFilterOperator.IsAnyOf,
      values: ["x"],
    },
  ];
  const query = new URLSearchParams();
  query.append("assigneeIds", UUID_A);
  query.append("assigneeIds", UUID_B);
  query.append("tagIds", UUID_B);
  query.set("includeUnassigned", "true");
  query.set("favoritesOnly", "true");
  query.set("customFieldFilters", JSON.stringify(facets));
  const response = await getSummary(
    `http://localhost:3002/documents/summary?${query}`
  );
  expect(response.status).toBe(200);
  expect(mockSummarize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      assigneeIds: [UUID_A, UUID_B],
      tagIds: [UUID_B],
      includeUnassigned: true,
      favoritesOnly: true,
      customFieldFilters: facets,
      organizationId: mockAuthContext.user.organizationId,
    }),
    mockAuthContext.user.id
  );
});

it("maps a refused custom-field facet to 400", async () => {
  mockSummarize.mockResolvedValueOnce({
    ok: false,
    error: CustomFieldQueryRejection.UnknownField,
  });
  const response = await getSummary(
    `http://localhost:3002/documents/summary?customFieldFilters=${encodeURIComponent(
      JSON.stringify([
        { fieldId: UUID_A, operator: CustomFieldFilterOperator.IsNotEmpty },
      ])
    )}`
  );
  expect(response.status).toBe(400);
});

it("retains repeated exact IDs and explicit empty cohorts", async () => {
  const ids = [
    "00000000-0000-4000-8000-000000000001",
    "00000000-0000-4000-8000-000000000002",
  ];
  const response = await getSummary(
    `http://localhost:3002/documents/summary?artifactIds=${ids[0]}&artifactIds=${ids[1]}`
  );
  expect(response.status).toBe(200);
  expect(mockSummarize).toHaveBeenLastCalledWith(
    expect.objectContaining({
      artifactIds: ids,
      organizationId: mockAuthContext.user.organizationId,
    }),
    mockAuthContext.user.id
  );
  const empty = await getSummary(
    "http://localhost:3002/documents/summary?artifactIds="
  );
  expect(empty.status).toBe(200);
  expect(mockSummarize).toHaveBeenLastCalledWith(
    expect.objectContaining({ artifactIds: [] }),
    mockAuthContext.user.id
  );
});

it("rejects unbounded and malformed exact cohorts", async () => {
  const params = new URLSearchParams();
  for (let i = 0; i < DOCUMENT_SUMMARY_ID_BATCH_SIZE + 1; i += 1) {
    params.append("artifactIds", "00000000-0000-4000-8000-000000000001");
  }
  expect(
    (await getSummary(`http://localhost:3002/documents/summary?${params}`))
      .status
  ).toBe(400);
  expect(
    (
      await getSummary(
        "http://localhost:3002/documents/summary?artifactIds=invalid"
      )
    ).status
  ).toBe(400);
});
