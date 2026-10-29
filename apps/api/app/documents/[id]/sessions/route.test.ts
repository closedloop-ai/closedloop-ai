import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  resolveDocumentId: vi.fn(),
  readSessions: vi.fn(),
  options: [] as unknown[],
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options: unknown
  ) => {
    mocks.options.push(options);
    return (request: NextRequest, context: { params: unknown }) =>
      handler(
        {
          user: {
            id: "user-a",
            clerkId: "clerk-user-a",
            organizationId: "org-a",
          },
        },
        request,
        context.params
      );
  },
}));
vi.mock("@/lib/identifier-utils", async (importOriginal) => {
  const actual =
    await importOriginal<typeof import("@/lib/identifier-utils")>();
  return { ...actual, resolveDocumentId: mocks.resolveDocumentId };
});
vi.mock("@/app/documents/document-sessions-service", () => ({
  documentSessionsService: { readSessions: mocks.readSessions },
}));

import { GET } from "./route";

describe("document Sessions route", () => {
  beforeEach(() => {
    mocks.resolveDocumentId.mockResolvedValue(
      "22222222-2222-7222-8222-222222222222"
    );
    mocks.readSessions.mockResolvedValue({
      detail: { id: "document" },
      trace: { items: [] },
    });
  });
  it("rejects malformed identifiers before any lookup", async () => {
    const response = await call("bad-id");
    expect(response.status).toBe(400);
    expect(mocks.resolveDocumentId).not.toHaveBeenCalled();
    expect(mocks.readSessions).not.toHaveBeenCalled();
  });
  it("resolves slugs and returns the document-scoped service result", async () => {
    const response = await call("PLN-2171");
    expect(response.status).toBe(200);
    expect(mocks.resolveDocumentId).toHaveBeenCalledWith("PLN-2171", "org-a");
    expect(mocks.readSessions).toHaveBeenCalledWith(
      "org-a",
      "22222222-2222-7222-8222-222222222222",
      expect.any(AbortSignal)
    );
    expect(await response.json()).toMatchObject({
      success: true,
      data: { detail: { id: "document" } },
    });
    expect(mocks.options[0]).toEqual({ requiredScopes: ["read"] });
  });
  it("maps a missing document to 404 without reading its sessions", async () => {
    mocks.resolveDocumentId.mockResolvedValue(null);
    expect((await call("PLN-2171")).status).toBe(404);
    expect(mocks.readSessions).not.toHaveBeenCalled();
  });
  it("maps a document removed between resolution and read to 404", async () => {
    mocks.readSessions.mockResolvedValue(null);
    expect((await call("PLN-2171")).status).toBe(404);
  });
});

function call(id: string) {
  return GET(
    new NextRequest(`https://api.example.test/documents/${id}/sessions`),
    { params: Promise.resolve({ id }) }
  );
}
