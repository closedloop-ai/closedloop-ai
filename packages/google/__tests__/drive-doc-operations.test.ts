import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The two per-document Drive calls: `exportDocAsMarkdown`, which produces the
 * body an import writes, and `getDocName`, which labels it.
 *
 * They disagree on failure — export rethrows, name-lookup swallows — and that
 * asymmetry is what the import service is written against, so both halves are
 * pinned here rather than assumed.
 */

const { mockFilesExport, mockFilesGet, mockDrive } = vi.hoisted(() => {
  const filesExport = vi.fn();
  const filesGet = vi.fn();
  return {
    mockFilesExport: filesExport,
    mockFilesGet: filesGet,
    mockDrive: vi.fn(() => ({
      files: { export: filesExport, get: filesGet, list: vi.fn() },
    })),
  };
});

const { logMock } = vi.hoisted(() => ({
  logMock: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

vi.mock("server-only", () => ({}));

vi.mock("googleapis", () => ({
  google: { drive: mockDrive },
}));

vi.mock("@repo/observability/log", () => ({ log: logMock }));

import {
  exportDocAsMarkdown,
  GOOGLE_DOCS_MIME_TYPE,
  getDocName,
} from "../index";

const DOC_ID = "doc-1";
const ACCESS_TOKEN = "access-token-1";
const MARKDOWN = "# Heading\n\nBody text.\n";

describe("exportDocAsMarkdown", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("authenticates the Drive client with the caller's access token", async () => {
    mockFilesExport.mockResolvedValue({ data: MARKDOWN });

    await exportDocAsMarkdown(DOC_ID, ACCESS_TOKEN);

    expect(mockDrive).toHaveBeenCalledWith({
      version: "v3",
      auth: ACCESS_TOKEN,
    });
  });

  it("asks Drive for text/markdown as a text response", async () => {
    mockFilesExport.mockResolvedValue({ data: MARKDOWN });

    await exportDocAsMarkdown(DOC_ID, ACCESS_TOKEN);

    const [params, options] = mockFilesExport.mock.calls[0] ?? [];
    expect(params).toEqual({ fileId: DOC_ID, mimeType: "text/markdown" });
    // Without responseType "text" googleapis would parse the body as JSON and
    // the markdown would come back mangled.
    expect(options).toEqual({ responseType: "text" });
  });

  it("returns the exported markdown body", async () => {
    mockFilesExport.mockResolvedValue({ data: MARKDOWN });

    await expect(exportDocAsMarkdown(DOC_ID, ACCESS_TOKEN)).resolves.toBe(
      MARKDOWN
    );
  });

  it("rethrows so the import can classify the failure per document", async () => {
    mockFilesExport.mockRejectedValue(new Error("Request failed with 404"));

    await expect(
      exportDocAsMarkdown(DOC_ID, ACCESS_TOKEN)
    ).rejects.toThrowError("Request failed with 404");
  });
});

describe("getDocName", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it("requests only the name field", async () => {
    mockFilesGet.mockResolvedValue({ data: { name: "Design Doc" } });

    await getDocName(DOC_ID, ACCESS_TOKEN);

    expect(mockFilesGet).toHaveBeenCalledWith({
      fileId: DOC_ID,
      fields: "name",
    });
    expect(mockDrive).toHaveBeenCalledWith({
      version: "v3",
      auth: ACCESS_TOKEN,
    });
  });

  it("returns the file name Drive reports", async () => {
    mockFilesGet.mockResolvedValue({ data: { name: "Design Doc" } });

    await expect(getDocName(DOC_ID, ACCESS_TOKEN)).resolves.toBe("Design Doc");
  });

  it("returns null when Drive omits the name", async () => {
    mockFilesGet.mockResolvedValue({ data: {} });

    await expect(getDocName(DOC_ID, ACCESS_TOKEN)).resolves.toBeNull();
  });

  it("returns null rather than throwing when the lookup fails", async () => {
    mockFilesGet.mockRejectedValue(new Error("Request failed with 403"));

    // Unlike every sibling in this module, a name lookup is advisory: the
    // import proceeds with a fallback label rather than aborting the document.
    await expect(getDocName(DOC_ID, ACCESS_TOKEN)).resolves.toBeNull();
    expect(logMock.error).toHaveBeenCalledTimes(1);
  });
});

describe("GOOGLE_DOCS_MIME_TYPE", () => {
  it("is the Drive mime type consumers filter folder listings on", () => {
    // Exported so callers filter on the same constant listDocsInFolder queries
    // with; a drift here silently empties every folder listing.
    expect(GOOGLE_DOCS_MIME_TYPE).toBe("application/vnd.google-apps.document");
  });
});
