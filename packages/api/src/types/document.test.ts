import { describe, expect, it } from "vitest";
import {
  type ArtifactRepositoryEntry,
  type ArtifactRepositorySnapshot,
  type BranchInfo,
  buildDocumentListContinuationHeaders,
  buildScopedDocumentPath,
  type CreateDocumentInput,
  type CreateDocumentRequestBody,
  DOCUMENT_LIST_CONTINUATION_HEADERS,
  DOCUMENT_LIST_MAX_OFFSET,
  DOCUMENT_ROUTE_PREFIX,
  DOCUMENT_TYPE_OPTIONS,
  DocumentType,
  DocumentTypeAlias,
  type FindDocumentsOptions,
  getPrimaryRepoFromSnapshot,
  getRoutePrefixForType,
  isProjectOptionalDocumentType,
  LEGACY_TYPE_ROUTE_PREFIXES,
  normalizeDocumentListResponse,
  type PullRequestInfo,
  PullRequestState,
  pickBranchForRepo,
  pickPullRequestForRepo,
  RepositoryRole,
  SnapshotSource,
  TYPE_ROUTE_PREFIX,
} from "./document";

function makeRepoEntry(
  overrides: Partial<ArtifactRepositoryEntry> = {}
): ArtifactRepositoryEntry {
  return {
    fullName: "closedloop-ai/closedloop-ai",
    role: RepositoryRole.Additional,
    position: 0,
    branch: null,
    ref: null,
    ...overrides,
  };
}

function makeBranchInfo(overrides: Partial<BranchInfo> = {}): BranchInfo {
  return {
    id: "branch-1",
    name: "feature/example",
    htmlUrl: null,
    branchName: "feature/example",
    baseBranch: "main",
    headSha: null,
    checksStatus: null,
    externalLinkId: null,
    repoFullName: "closedloop-ai/closedloop-ai",
    currentPullRequest: null,
    ...overrides,
  };
}

function makePullRequestInfo(
  overrides: Partial<PullRequestInfo> = {}
): PullRequestInfo {
  return {
    id: "pr-1",
    number: 1,
    title: "Example PR",
    htmlUrl: "https://github.com/closedloop-ai/closedloop-ai/pull/1",
    state: PullRequestState.Open,
    isDraft: false,
    headBranch: "feature/example",
    baseBranch: "main",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    checksStatus: null,
    reviewDecision: null,
    externalLinkId: null,
    repoFullName: "closedloop-ai/closedloop-ai",
    ...overrides,
  };
}

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

// ISS-4576 (davetho review): the paged read survives version skew. An older
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

describe("getRoutePrefixForType (templates)", () => {
  it("returns null for a template, which has no detail route", () => {
    expect(getRoutePrefixForType(DocumentType.Template)).toBeNull();
  });
});

describe("getRoutePrefixForType (ISS-12855)", () => {
  it.each([
    DocumentType.Prd,
    DocumentType.ImplementationPlan,
    DocumentType.Feature,
    DocumentType.Doc,
  ])("routes %s under the documents prefix", (type) => {
    expect(getRoutePrefixForType(type)).toBe(DOCUMENT_ROUTE_PREFIX);
  });

  it("keeps every retired per-type prefix in LEGACY_TYPE_ROUTE_PREFIXES", () => {
    expect(Object.values(LEGACY_TYPE_ROUTE_PREFIXES).flat().sort()).toEqual([
      "features",
      "implementation-plans",
      "issues",
      "prds",
    ]);
  });
});

describe("getPrimaryRepoFromSnapshot (ISS-7030)", () => {
  it("returns null when the snapshot is null", () => {
    expect(getPrimaryRepoFromSnapshot(null)).toBeNull();
  });

  it("returns the entry whose role is primary, even when it is not first", () => {
    const additional = makeRepoEntry({
      fullName: "org/additional",
      role: RepositoryRole.Additional,
      position: 0,
    });
    const primary = makeRepoEntry({
      fullName: "org/primary",
      role: RepositoryRole.Primary,
      position: 1,
    });
    const snapshot: ArtifactRepositorySnapshot = {
      repositories: [additional, primary],
      source: SnapshotSource.LoopSelection,
    };

    expect(getPrimaryRepoFromSnapshot(snapshot)).toEqual(primary);
  });

  it("falls back to the first repository when none is marked primary", () => {
    const first = makeRepoEntry({
      fullName: "org/first",
      role: RepositoryRole.Additional,
      position: 0,
    });
    const second = makeRepoEntry({
      fullName: "org/second",
      role: RepositoryRole.Additional,
      position: 1,
    });
    const snapshot: ArtifactRepositorySnapshot = {
      repositories: [first, second],
      source: SnapshotSource.LoopSelection,
    };

    expect(getPrimaryRepoFromSnapshot(snapshot)).toEqual(first);
  });

  it("returns null when the snapshot has no repositories", () => {
    const snapshot: ArtifactRepositorySnapshot = {
      repositories: [],
      source: SnapshotSource.None,
    };

    expect(getPrimaryRepoFromSnapshot(snapshot)).toBeNull();
  });
});

describe("pickBranchForRepo (ISS-7030)", () => {
  it("returns null when branches is undefined", () => {
    expect(pickBranchForRepo(undefined, "org/repo")).toBeNull();
  });

  it("returns null when branches is an empty array", () => {
    expect(pickBranchForRepo([], "org/repo")).toBeNull();
  });

  it("returns the branch matching repoFullName when one exists", () => {
    const other = makeBranchInfo({ id: "b-other", repoFullName: "org/other" });
    const match = makeBranchInfo({
      id: "b-match",
      repoFullName: "org/target",
    });

    expect(pickBranchForRepo([other, match], "org/target")).toEqual(match);
  });

  // pins current behavior; looks odd because the fallback is the first branch
  // overall (possibly for an unrelated repo) rather than null when repoFullName
  // has no match
  it("falls back to the first branch when repoFullName has no match", () => {
    const first = makeBranchInfo({ id: "b-first", repoFullName: "org/one" });
    const second = makeBranchInfo({ id: "b-second", repoFullName: "org/two" });

    expect(pickBranchForRepo([first, second], "org/does-not-exist")).toEqual(
      first
    );
  });

  it("returns the first branch directly when repoFullName is not supplied", () => {
    const first = makeBranchInfo({ id: "b-first", repoFullName: "org/one" });
    const second = makeBranchInfo({ id: "b-second", repoFullName: "org/two" });

    expect(pickBranchForRepo([first, second], undefined)).toEqual(first);
  });
});

describe("pickPullRequestForRepo (ISS-7030)", () => {
  it("returns null when pullRequests is undefined", () => {
    expect(pickPullRequestForRepo(undefined, "org/repo")).toBeNull();
  });

  it("returns null when pullRequests is an empty array", () => {
    expect(pickPullRequestForRepo([], "org/repo")).toBeNull();
  });

  it("returns the pull request matching repoFullName when one exists", () => {
    const other = makePullRequestInfo({
      id: "pr-other",
      repoFullName: "org/other",
    });
    const match = makePullRequestInfo({
      id: "pr-match",
      repoFullName: "org/target",
    });

    expect(pickPullRequestForRepo([other, match], "org/target")).toEqual(match);
  });

  // pins current behavior; looks odd because the fallback is the first pull
  // request overall (possibly for an unrelated repo) rather than null when
  // repoFullName has no match
  it("falls back to the first pull request when repoFullName has no match", () => {
    const first = makePullRequestInfo({
      id: "pr-first",
      repoFullName: "org/one",
    });
    const second = makePullRequestInfo({
      id: "pr-second",
      repoFullName: "org/two",
    });

    expect(
      pickPullRequestForRepo([first, second], "org/does-not-exist")
    ).toEqual(first);
  });

  it("returns the first pull request directly when repoFullName is not supplied", () => {
    const first = makePullRequestInfo({
      id: "pr-first",
      repoFullName: "org/one",
    });
    const second = makePullRequestInfo({
      id: "pr-second",
      repoFullName: "org/two",
    });

    expect(pickPullRequestForRepo([first, second], undefined)).toEqual(first);
  });
});

describe("buildScopedDocumentPath (ISS-7030)", () => {
  it("prefixes the path with the org slug when provided", () => {
    expect(buildScopedDocumentPath("prds", "my-doc", "acme")).toBe(
      "/acme/prds/my-doc"
    );
  });

  it("omits the org segment when orgSlug is not provided", () => {
    expect(buildScopedDocumentPath("prds", "my-doc")).toBe("/prds/my-doc");
  });
});

describe("isProjectOptionalDocumentType (ISS-7030)", () => {
  it("returns true for DOC, an org-level type", () => {
    expect(isProjectOptionalDocumentType(DocumentType.Doc)).toBe(true);
  });

  it("returns true for TEMPLATE, an org-level type", () => {
    expect(isProjectOptionalDocumentType(DocumentType.Template)).toBe(true);
  });

  it("returns false for PRD, a project-bound type", () => {
    expect(isProjectOptionalDocumentType(DocumentType.Prd)).toBe(false);
  });
});

describe("buildDocumentListContinuationHeaders", () => {
  it("includes NextOffset when more rows exist and the next offset is fetchable", () => {
    const headers = buildDocumentListContinuationHeaders({
      total: 50,
      offset: 0,
      pageCount: 25,
      hasMore: true,
    });
    expect(headers).toEqual({
      [DOCUMENT_LIST_CONTINUATION_HEADERS.Total]: "50",
      [DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore]: "true",
      [DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset]: "25",
    });
  });

  it("omits NextOffset when hasMore is false, even if pageCount could advance an offset", () => {
    const headers = buildDocumentListContinuationHeaders({
      total: 25,
      offset: 0,
      pageCount: 25,
      hasMore: false,
    });
    expect(headers).toEqual({
      [DOCUMENT_LIST_CONTINUATION_HEADERS.Total]: "25",
      [DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore]: "false",
    });
    expect(DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset in headers).toBe(
      false
    );
  });

  it("includes NextOffset past DOCUMENT_LIST_MAX_OFFSET, which the endpoint now serves (ISS-11161)", () => {
    const headers = buildDocumentListContinuationHeaders({
      total: DOCUMENT_LIST_MAX_OFFSET + 100,
      offset: DOCUMENT_LIST_MAX_OFFSET - 10,
      pageCount: 25,
      hasMore: true,
    });
    expect(headers[DOCUMENT_LIST_CONTINUATION_HEADERS.HasMore]).toBe("true");
    expect(headers[DOCUMENT_LIST_CONTINUATION_HEADERS.NextOffset]).toBe(
      String(DOCUMENT_LIST_MAX_OFFSET + 15)
    );
  });
});
