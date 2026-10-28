/**
 * ISS-9713 branch coverage for GET /integrations/google/files.
 *
 * The route had no suite at all — every branch (the two folderId rejections,
 * the not-connected and token-refresh arms, and the three-way Drive error
 * classification) was unexercised. Everything here pins what `main` does today.
 */

import type { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: {
    user: { id: "user-1", organizationId: "org-1" },
    authMethod: "session",
  },
  listDocsInFolder: vi.fn(),
  getIntegration: vi.fn(),
  ensureValidAccessToken: vi.fn(),
}));

vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth:
    (
      handler: (
        ctx: unknown,
        request: NextRequest,
        params: unknown
      ) => Promise<Response>
    ) =>
    (request: NextRequest, context: unknown) =>
      handler(mocks.auth, request, (context as { params: unknown })?.params),
}));

vi.mock("@repo/google", () => ({
  listDocsInFolder: mocks.listDocsInFolder,
}));

vi.mock("../service", () => ({
  googleService: { getIntegration: mocks.getIntegration },
  ensureValidAccessToken: mocks.ensureValidAccessToken,
}));

vi.mock("@repo/observability/log", () => ({
  log: {
    error: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    flush: vi.fn(async () => undefined),
  },
}));

import { GET } from "./route";

const ORGANIZATION_ID = "org-1";
const FOLDER_ID = "1AbC_dEf-GhI";
const ACCESS_TOKEN = "ya29.token";

function buildRequest(query: string): NextRequest {
  const url = new URL(`https://api.test/integrations/google/files${query}`);
  return {
    nextUrl: url,
    url: url.toString(),
  } as unknown as NextRequest;
}

function callGet(query = `?folderId=${FOLDER_ID}`): Promise<Response> {
  return (GET as unknown as (request: NextRequest) => Promise<Response>)(
    buildRequest(query)
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.getIntegration.mockResolvedValue({ id: "integration-1" });
  mocks.ensureValidAccessToken.mockResolvedValue({
    success: true,
    accessToken: ACCESS_TOKEN,
  });
  mocks.listDocsInFolder.mockResolvedValue([]);
});

describe("GET google files — request validation", () => {
  it("400s when folderId is absent", async () => {
    const response = await callGet("");

    expect(response.status).toBe(400);
    expect(mocks.getIntegration).not.toHaveBeenCalled();
  });

  it("400s when folderId is present but empty", async () => {
    const response = await callGet("?folderId=");

    expect(response.status).toBe(400);
    expect(mocks.getIntegration).not.toHaveBeenCalled();
  });

  it("400s when folderId carries characters outside the allowed set", async () => {
    const response = await callGet("?folderId=../etc/passwd");

    expect(response.status).toBe(400);
    expect(mocks.getIntegration).not.toHaveBeenCalled();
  });
});

describe("GET google files — integration preconditions", () => {
  it("400s when the org has no Google Drive integration", async () => {
    mocks.getIntegration.mockResolvedValue(null);

    const response = await callGet();

    expect(response.status).toBe(400);
    expect(mocks.ensureValidAccessToken).not.toHaveBeenCalled();
  });

  it("401s when the stored token cannot be refreshed", async () => {
    mocks.ensureValidAccessToken.mockResolvedValue({
      success: false,
      error: "Token refresh failed",
    });

    const response = await callGet();

    expect(response.status).toBe(401);
    expect(mocks.listDocsInFolder).not.toHaveBeenCalled();
  });

  it("passes the caller's organization id to the integration lookup", async () => {
    await callGet();

    expect(mocks.getIntegration).toHaveBeenCalledWith(ORGANIZATION_ID);
  });
});

describe("GET google files — Drive results", () => {
  it("returns only the id and name of each doc", async () => {
    mocks.listDocsInFolder.mockResolvedValue([
      {
        id: "doc-1",
        name: "Plan",
        mimeType: "application/vnd.google-apps.document",
      },
      { id: "doc-2", name: "Notes", webViewLink: "https://drive/doc-2" },
    ]);

    const response = await callGet();

    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toMatchObject({
      data: [
        { id: "doc-1", name: "Plan" },
        { id: "doc-2", name: "Notes" },
      ],
    });
  });

  it("passes the refreshed access token through to the Drive client", async () => {
    await callGet();

    expect(mocks.listDocsInFolder).toHaveBeenCalledWith(
      FOLDER_ID,
      ACCESS_TOKEN
    );
  });
});

describe("GET google files — Drive error classification", () => {
  it("maps a 404-shaped Drive error to 404 Folder not found", async () => {
    mocks.listDocsInFolder.mockRejectedValue(new Error("Request failed: 404"));

    const response = await callGet();

    expect(response.status).toBe(404);
  });

  it("maps a not-found message with no status code to 404", async () => {
    mocks.listDocsInFolder.mockRejectedValue(new Error("folder not found"));

    const response = await callGet();

    expect(response.status).toBe(404);
  });

  it("maps a 403-shaped Drive error to 403 Folder not accessible", async () => {
    mocks.listDocsInFolder.mockRejectedValue(new Error("Request failed: 403"));

    const response = await callGet();

    expect(response.status).toBe(403);
  });

  it("maps a permission-denied message with no status code to 403", async () => {
    mocks.listDocsInFolder.mockRejectedValue(new Error("Permission denied"));

    const response = await callGet();

    expect(response.status).toBe(403);
  });

  it("falls back to a 500 for an unclassified Drive failure", async () => {
    mocks.listDocsInFolder.mockRejectedValue(new Error("socket hang up"));

    const response = await callGet();

    expect(response.status).toBe(500);
  });
});
