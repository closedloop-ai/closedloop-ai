/**
 * ISS-6941 — `GET /documents` states its pagination continuation in response
 * headers on the bare-array arm.
 *
 * Split out of `route.test.ts`, which reached the 1,000-line ceiling when these
 * cases landed. The seam is a real one rather than a line-count slice: this file
 * owns ONE contract — what the endpoint says about the bound it applied — and
 * needs only the GET half of that route's scaffolding, while `route.test.ts`
 * keeps the filter/validation/POST surface.
 */
import {
  DOCUMENT_LIST_MAX_OFFSET,
  DocumentType,
} from "@repo/api/src/types/document";
import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { AuthContext } from "@/lib/auth/with-auth";
import {
  createMockRouteContext,
  createTestAuthContext,
} from "../../../__tests__/utils/auth-helpers";

let mockAuthContext: AuthContext;
const mockFindAllWithCustomFields = vi.hoisted(() => vi.fn());
const mockFindPageWithCustomFields = vi.hoisted(() => vi.fn());
const mockFindArrayWithContinuation = vi.hoisted(() => vi.fn());
const mockReadArrayWithContinuationInSnapshot = vi.hoisted(() => vi.fn());
const mockReadDocumentListInSnapshot = vi.hoisted(() => vi.fn());

// The real capture schedules an un-awaited `waitUntil` that opens a pg pool
// against the unit lane's placeholder DATABASE_URL; replaced purely for
// isolation, exactly as `route.test.ts` does.
vi.mock("@/lib/artifact-activity-capture", () => ({
  captureArtifactCreation: vi.fn(),
}));

vi.mock("@/app/documents/attachment-upload-feature", () => ({
  isMcpAttachmentUploadEnabled: vi.fn(),
}));

vi.mock("@/app/documents/document-service", () => ({
  documentService: {
    create: vi.fn(),
    createWithInlineImages: vi.fn(),
    findAllWithCustomFields: mockFindAllWithCustomFields,
  },
}));

vi.mock("@/app/documents/document-list-service", () => ({
  documentListService: {
    findPageWithCustomFields: mockFindPageWithCustomFields,
    findArrayWithContinuation: mockFindArrayWithContinuation,
    readArrayWithContinuationInSnapshot:
      mockReadArrayWithContinuationInSnapshot,
  },
}));

// PARTIAL: `requiresCustomFieldSnapshot` stays REAL, so which arm a request
// takes is still decided by the request itself. Only the read is replaced, and
// it invokes the callback it was handed, so the route's wiring through
// `readArrayWithContinuationInSnapshot` is exercised rather than stubbed past.
vi.mock("@/app/documents/document-list-snapshot", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  readDocumentListInSnapshot: mockReadDocumentListInSnapshot,
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (handler: (context: AuthContext, request: Request) => unknown) =>
    (request: Request) =>
      handler(mockAuthContext, request),
}));

vi.mock("@/lib/identifier-utils", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  resolveArtifactIdentifier: vi.fn(async (id: string) => id),
  resolveProjectId: vi.fn(async (id: string) => id),
}));

import { GET } from "../route";

/** A custom-field id, so the REAL `requiresCustomFieldSnapshot` selects the snapshot arm. */
const CUSTOM_FIELD_ID = "44444444-4444-4444-8444-444444444444";

describe("GET /documents continuation headers (ISS-6941)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthContext = createTestAuthContext();
  });

  it("states the bound it applied when the caller paged", async () => {
    // The filed case: a caller paging `limit`+`offset` with no `includeTotal`.
    // The BODY stays the bare array it has always been, and the answer to "was
    // I capped?" arrives beside it.
    mockFindArrayWithContinuation.mockResolvedValue({
      items: [{ id: "doc-1" }],
      continuation: { total: 1101, offset: 500, pageCount: 500, hasMore: true },
    });

    const response = await getDocuments(
      "http://localhost:3002/documents?limit=500&offset=500"
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(Array.isArray(body.data)).toBe(true);
    expect(response.headers.get("x-document-list-total")).toBe("1101");
    expect(response.headers.get("x-document-list-has-more")).toBe("true");
    // Advanced past the rows SERVED, which is what the caller must send next.
    expect(response.headers.get("x-document-list-next-offset")).toBe("1000");
  });

  it("withholds a next offset once there is nothing beyond the page", async () => {
    mockFindArrayWithContinuation.mockResolvedValue({
      items: [],
      continuation: { total: 12, offset: 12, pageCount: 0, hasMore: false },
    });

    const response = await getDocuments(
      "http://localhost:3002/documents?limit=50&offset=12"
    );

    expect(response.headers.get("x-document-list-has-more")).toBe("false");
    // Absent, not "12": an offset for a page that does not exist is an
    // invitation to request it.
    expect(response.headers.get("x-document-list-next-offset")).toBeNull();
  });

  it("offers the next offset past DOCUMENT_LIST_MAX_OFFSET, which the endpoint now serves (ISS-11161)", async () => {
    mockFindArrayWithContinuation.mockResolvedValue({
      items: [{ id: "doc-1" }],
      continuation: {
        total: 20_000,
        offset: DOCUMENT_LIST_MAX_OFFSET - 40,
        pageCount: 50,
        hasMore: true,
      },
    });

    const response = await getDocuments(
      `http://localhost:3002/documents?limit=50&offset=${DOCUMENT_LIST_MAX_OFFSET - 40}`
    );

    expect(response.headers.get("x-document-list-has-more")).toBe("true");
    expect(response.headers.get("x-document-list-total")).toBe("20000");
    expect(response.headers.get("x-document-list-next-offset")).toBe(
      String(DOCUMENT_LIST_MAX_OFFSET + 10)
    );
  });

  it("says an unbounded read was everything", async () => {
    mockFindAllWithCustomFields.mockResolvedValue([{ id: "a" }, { id: "b" }]);
    mockFindArrayWithContinuation.mockImplementation(
      async (options: unknown) => {
        const items = await mockFindAllWithCustomFields(options);
        return {
          items,
          continuation: {
            total: items.length,
            offset: 0,
            pageCount: items.length,
            hasMore: false,
          },
        };
      }
    );

    const response = await getDocuments("http://localhost:3002/documents");

    expect(response.headers.get("x-document-list-total")).toBe("2");
    expect(response.headers.get("x-document-list-has-more")).toBe("false");
  });

  it("states the continuation on the custom-field snapshot arm too", async () => {
    // The OTHER arm that produces a bare array. `arrayResponse` exists so both
    // ship one header set; without a case here, routing the snapshot arm back
    // to a bare `successResponse` would leave every suite green while a client
    // sorting by a custom field got no continuation at all — the exact state
    // ISS-6941 was filed against.
    mockReadDocumentListInSnapshot.mockImplementation(
      async (
        options: unknown,
        _params: unknown,
        read: (options: unknown, now: Date) => Promise<unknown>
      ) => ({ ok: true, value: await read(options, new Date()) })
    );
    mockReadArrayWithContinuationInSnapshot.mockResolvedValue({
      items: [{ id: "doc-1" }],
      continuation: { total: 94, offset: 0, pageCount: 50, hasMore: true },
    });

    const response = await getDocuments(
      `http://localhost:3002/documents?limit=50&customFieldSortId=${CUSTOM_FIELD_ID}&customFieldSortDir=asc`
    );
    const body = await response.json();

    expect(response.status).toBe(200);
    // The snapshot read really was the one taken, and the route really did
    // route its callback through the continuation-bearing service method.
    expect(mockReadDocumentListInSnapshot).toHaveBeenCalled();
    expect(mockReadArrayWithContinuationInSnapshot).toHaveBeenCalled();
    expect(Array.isArray(body.data)).toBe(true);
    expect(response.headers.get("x-document-list-total")).toBe("94");
    expect(response.headers.get("x-document-list-has-more")).toBe("true");
    expect(response.headers.get("x-document-list-next-offset")).toBe("50");
  });

  it("leaves the envelope arm's body to speak for itself", async () => {
    mockFindPageWithCustomFields.mockResolvedValue({
      items: [],
      total: 7,
      limit: 50,
      offset: 0,
      hasMore: false,
    });

    const response = await getDocuments(
      "http://localhost:3002/documents?limit=50&includeTotal=true"
    );
    const body = await response.json();

    // The envelope already answers this IN the body; emitting the same facts a
    // second time in headers would be two statements of one thing, free to
    // disagree. `total` is asserted present in the body so this is a claim
    // about where the answer lives, not that there is no answer.
    expect(body.data.total).toBe(7);
    expect(response.headers.get("x-document-list-total")).toBeNull();
    expect(response.headers.get("x-document-list-has-more")).toBeNull();
  });

  it("forwards the org-level project-less DOC filter on this arm", async () => {
    // Non-vacuity guard for the mocks above: the continuation cases stub the
    // service wholesale, so this pins that the route still hands it the
    // caller's actual filter rather than something the stub would accept.
    mockFindArrayWithContinuation.mockResolvedValue({
      items: [],
      continuation: { total: 0, offset: 0, pageCount: 0, hasMore: false },
    });

    await getDocuments(
      "http://localhost:3002/documents?type=DOC&unassignedProject=true"
    );

    expect(mockFindArrayWithContinuation).toHaveBeenCalledWith(
      expect.objectContaining({
        organizationId: mockAuthContext.user.organizationId,
        type: DocumentType.Doc,
        unassignedProject: true,
      })
    );
  });
});

function getDocuments(url: string) {
  return GET(
    new NextRequest(url, { method: "GET" }),
    createMockRouteContext({})
  );
}
