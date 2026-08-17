import { describe, expect, it } from "vitest";
import {
  type CreateDocumentInput,
  type CreateDocumentRequestBody,
  DOCUMENT_TYPE_OPTIONS,
  DocumentType,
  DocumentTypeAlias,
  type FindDocumentsOptions,
  getRoutePrefixForType,
  normalizeDocumentListResponse,
  TYPE_ROUTE_PREFIX,
} from "./document";

// FEA-3949 Slice A: the DOC (evergreen document) subtype is re-exported through
// the shared API contract and routes to the /documents prefix.
describe("DocumentType DOC re-export + route prefix (FEA-3949)", () => {
  it("re-exports DOC as a DocumentType member", () => {
    expect(DocumentType.Doc).toBe("DOC");
    expect(DOCUMENT_TYPE_OPTIONS).toContain(DocumentType.Doc);
  });

  it("maps DocumentType.Doc to the documents route prefix", () => {
    expect(TYPE_ROUTE_PREFIX[DocumentType.Doc]).toBe("documents");
    expect(getRoutePrefixForType(DocumentType.Doc)).toBe("documents");
  });
});

// ISS-4397: the request-side shared contracts a typed caller constructs must
// accept the `ISSUE` alias (the runtime validators already normalize it to
// FEATURE). Before widening, `CreateDocumentInput.type` / `FindDocumentsOptions.type`
// were `DocumentType` and excluded `ISSUE`, so `useCreateDocument`/`useDocuments`
// could not send it without a cast. These are compile-time contract assertions —
// if a request-side `type` field is narrowed back to `DocumentType`, assigning
// `DocumentTypeAlias.Issue` fails `tsc`. The runtime expects merely anchor them.
describe("request contracts accept the ISSUE type alias (ISS-4397)", () => {
  it("CreateDocumentInput.type accepts ISSUE", () => {
    const input: CreateDocumentInput = {
      projectId: "project-id",
      type: DocumentTypeAlias.Issue,
      title: "Issue via the ISSUE alias",
      content: "",
    };
    expect(input.type).toBe(DocumentTypeAlias.Issue);
  });

  it("CreateDocumentRequestBody.type accepts ISSUE (inherited)", () => {
    const body: CreateDocumentRequestBody = {
      projectId: "project-id",
      type: DocumentTypeAlias.Issue,
      title: "Issue via the ISSUE alias",
      content: "",
    };
    expect(body.type).toBe(DocumentTypeAlias.Issue);
  });

  it("FindDocumentsOptions.type accepts ISSUE", () => {
    const options: FindDocumentsOptions = { type: DocumentTypeAlias.Issue };
    expect(options.type).toBe(DocumentTypeAlias.Issue);
  });

  it("request contracts still accept the canonical FEATURE type (compat)", () => {
    const input: CreateDocumentInput = {
      projectId: "project-id",
      type: DocumentType.Feature,
      title: "Feature via the canonical type",
      content: "",
    };
    const options: FindDocumentsOptions = { type: DocumentType.Feature };
    expect(input.type).toBe(DocumentType.Feature);
    expect(options.type).toBe(DocumentType.Feature);
  });
});

// ISS-4576 (shafty023 review): the paged read survives version skew. An older
// API strips the unknown `includeTotal` param and returns the legacy bare array;
// a current API returns the envelope. `normalizeDocumentListResponse` folds
// either into a `DocumentListPage` so the client never mistakes a legacy array
// for an empty queue.
describe("normalizeDocumentListResponse (ISS-4576)", () => {
  it("passes a well-formed envelope through unchanged", () => {
    const envelope = {
      items: [{ id: "1" }, { id: "2" }],
      total: 137,
      limit: 50,
      offset: 50,
      hasMore: true,
    };

    const result = normalizeDocumentListResponse(envelope);

    expect(result.items).toHaveLength(2);
    expect(result.total).toBe(137);
    expect(result.limit).toBe(50);
    expect(result.offset).toBe(50);
    expect(result.hasMore).toBe(true);
  });

  it("folds a legacy bare array (old server) into an honest one-page envelope", () => {
    // The old server ignored `limit`, so the array is the whole matching set:
    // total is its length, no bound was applied, and there is no next page.
    const legacyArray = [{ id: "1" }, { id: "2" }, { id: "3" }];

    const result = normalizeDocumentListResponse(legacyArray);

    expect(result.items).toHaveLength(3);
    expect(result.total).toBe(3);
    expect(result.limit).toBeNull();
    expect(result.offset).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("folds an empty legacy array into an honest empty page (not a truncated one)", () => {
    const result = normalizeDocumentListResponse([]);

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.hasMore).toBe(false);
  });

  it("degrades a malformed body to a safe empty page rather than throwing", () => {
    const result = normalizeDocumentListResponse({ unexpected: "shape" });

    expect(result.items).toEqual([]);
    expect(result.total).toBe(0);
    expect(result.limit).toBeNull();
    expect(result.hasMore).toBe(false);
  });

  it("degrades a null/undefined body to a safe empty page", () => {
    expect(normalizeDocumentListResponse(null).items).toEqual([]);
    expect(normalizeDocumentListResponse(undefined).total).toBe(0);
  });
});
