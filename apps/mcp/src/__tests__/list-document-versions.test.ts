import { describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListDocumentVersions } from "../tools/list-document-versions.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

describe("list-document-versions MCP tool", () => {
  it("paginates the unwrapped version array returned by ApiClient", async () => {
    const get = vi.fn().mockResolvedValue([
      {
        id: "version-2",
        version: 2,
        createdAt: "2026-05-14T04:11:39.337Z",
        createdById: "user-1",
      },
      {
        id: "version-1",
        version: 1,
        createdAt: "2026-05-13T16:31:44.128Z",
        createdById: "user-1",
      },
    ]);
    const handler = createToolHarness(registerListDocumentVersions, {
      get,
    } as unknown as ApiClient);

    const payload = parseToolPayload(
      await handler({ documentId: "PLN-15", limit: 1, offset: 0 })
    );

    expect(get).toHaveBeenCalledWith("/documents/PLN-15/versions");
    expect(payload).toEqual({
      total: 2,
      offset: 0,
      limit: 1,
      returned: 1,
      hasMore: true,
      nextOffset: 1,
      items: [
        {
          id: "version-2",
          version: 2,
          createdAt: "2026-05-14T04:11:39.337Z",
          createdById: "user-1",
          contentLength: null,
        },
      ],
    });
  });
});
