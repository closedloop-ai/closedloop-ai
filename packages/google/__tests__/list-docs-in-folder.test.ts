import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The listing half of the Google Drive folder-import contract (ISS-5291).
 *
 * `listDocsInFolder` is what bounds the whole import: it asks Drive for a
 * single 100-item page and ignores `nextPageToken`, so every downstream count
 * — including the service's `totalDocsInFolder` — is capped at 100 no matter
 * how large the folder actually is.
 *
 * That cap is asserted here rather than assumed, because the import service
 * carries a >100 truncation branch whose reachability depends entirely on it.
 * If pagination is ever added, this test fails first and points at the
 * consumers that must change with it: the service's truncation reporting and
 * the import modal, which today has nothing extra to tell the user precisely
 * because this function cannot return more than a page.
 */

const GOOGLE_DOCS_MIME_TYPE = "application/vnd.google-apps.document";

const { mockFilesList, mockDrive } = vi.hoisted(() => {
  const filesList = vi.fn();
  return {
    mockFilesList: filesList,
    mockDrive: vi.fn(() => ({ files: { list: filesList } })),
  };
});

vi.mock("server-only", () => ({}));

vi.mock("googleapis", () => ({
  google: { drive: mockDrive },
}));

vi.mock("@repo/observability/log", () => ({
  log: { error: vi.fn(), info: vi.fn(), warn: vi.fn() },
}));

import { listDocsInFolder } from "../index";

const FOLDER_ID = "folder-1";
const ACCESS_TOKEN = "access-token-1";

function makeFiles(count: number) {
  return Array.from({ length: count }, (_unused, index) => ({
    id: `doc-${index}`,
    name: `Doc ${index}`,
    mimeType: GOOGLE_DOCS_MIME_TYPE,
  }));
}

describe("listDocsInFolder", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("asks for a single 100-item page", async () => {
    mockFilesList.mockResolvedValue({ data: { files: makeFiles(2) } });

    await listDocsInFolder(FOLDER_ID, ACCESS_TOKEN);

    expect(mockFilesList).toHaveBeenCalledTimes(1);
    expect(mockFilesList.mock.calls[0]?.[0]).toMatchObject({ pageSize: 100 });
  });

  it("stops at the first page even when Drive reports more are available", async () => {
    // Drive says there is another page. Today the function ignores it — this is
    // the cap the import service's truncation branch depends on.
    mockFilesList.mockResolvedValue({
      data: { files: makeFiles(100), nextPageToken: "page-2" },
    });

    const docs = await listDocsInFolder(FOLDER_ID, ACCESS_TOKEN);

    expect(mockFilesList).toHaveBeenCalledTimes(1);
    expect(docs).toHaveLength(100);
  });

  it("scopes the query to non-trashed Google Docs in the requested folder", async () => {
    mockFilesList.mockResolvedValue({ data: { files: [] } });

    await listDocsInFolder(FOLDER_ID, ACCESS_TOKEN);

    const query = mockFilesList.mock.calls[0]?.[0]?.q as string;
    expect(query).toContain(`'${FOLDER_ID}' in parents`);
    expect(query).toContain(`mimeType='${GOOGLE_DOCS_MIME_TYPE}'`);
    expect(query).toContain("trashed=false");
  });

  it("returns an empty list when Drive omits the files array", async () => {
    mockFilesList.mockResolvedValue({ data: {} });

    await expect(listDocsInFolder(FOLDER_ID, ACCESS_TOKEN)).resolves.toEqual(
      []
    );
  });

  it("rethrows so the caller can classify the failure", async () => {
    mockFilesList.mockRejectedValue(new Error("Request failed with 403"));

    // The import service maps 403/404 to specific folder-level messages, which
    // only works because this function does not swallow the error.
    await expect(
      listDocsInFolder(FOLDER_ID, ACCESS_TOKEN)
    ).rejects.toThrowError("Request failed with 403");
  });
});
