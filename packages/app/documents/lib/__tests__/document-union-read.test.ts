import { DocumentType } from "@repo/api/src/types/document";
import type { DocumentListSummary } from "@repo/api/src/types/document-list-summary";
import { ApiError } from "@repo/app/shared/api/api-error";
import type { ApiClient } from "@repo/app/shared/api/create-api-client";
import { createMockDocument } from "@repo/app/shared/test-fixtures/documents";
import { describe, expect, it, vi } from "vitest";
import {
  readDocumentPageWithSubtypeUnion,
  readDocumentSummaryWithSubtypeUnion,
  readDocumentsWithSubtypeUnion,
} from "../document-union-read";

describe("union subtype reads across API versions", () => {
  it("uses the server page and total when the subtype union was applied", async () => {
    const page = {
      items: [],
      total: 120,
      limit: 25,
      offset: 25,
      hasMore: true,
      appliedTypes: types,
    };
    const get = vi.fn().mockResolvedValue(page);
    expect(
      await readDocumentPageWithSubtypeUnion({ get } as unknown as ApiClient, {
        types,
        limit: 25,
        offset: 25,
      })
    ).toEqual(page);
    expect(get).toHaveBeenCalledTimes(1);
  });

  it("reconstructs a correctly ordered combined page when an old server ignores types", async () => {
    const get = vi.fn((url: string) => {
      const params = new URL(url, "https://api.test").searchParams;
      if (params.has("types")) {
        return { items: [], total: 999, limit: 1, offset: 1, hasMore: true };
      }
      const type = params.get("type");
      return [
        createMockDocument({
          id: type!,
          type: type as typeof DocumentType.Prd,
          createdAt: new Date(
            type === DocumentType.Doc ? "2026-10-07" : "2026-10-06"
          ),
        }),
      ];
    });
    const page = await readDocumentPageWithSubtypeUnion(
      { get } as unknown as ApiClient,
      { types, limit: 1, offset: 1 }
    );
    expect(page.total).toBe(3);
    expect(page.items.map((row) => row.id)).toEqual([DocumentType.Prd]);
    expect(page.hasMore).toBe(true);
    expect(
      get.mock.calls
        .slice(1)
        .every(
          ([url]) => !new URL(url, "https://api.test").searchParams.has("limit")
        )
    ).toBe(true);
  });

  it("falls back to scalar filters only for unsupported union errors", async () => {
    const get = vi.fn((url: string) => {
      const params = new URL(url, "https://api.test").searchParams;
      if (params.has("types")) {
        throw new ApiError("Unrecognized key: types", 400);
      }
      return [
        createMockDocument({
          type: params.get("type") as typeof DocumentType.Prd,
        }),
      ];
    });
    expect(
      await readDocumentsWithSubtypeUnion({ get } as unknown as ApiClient, {
        types,
      })
    ).toHaveLength(3);
    const denied = vi.fn().mockRejectedValue(new ApiError("Forbidden", 403));
    await expect(
      readDocumentsWithSubtypeUnion({ get: denied } as unknown as ApiClient, {
        types,
      })
    ).rejects.toMatchObject({ status: 403 });
    expect(denied).toHaveBeenCalledTimes(1);
  });

  it("never accepts an old whole-org aggregate as the combined subtype summary", async () => {
    const get = vi.fn((url: string) => {
      const params = new URL(url, "https://api.test").searchParams;
      const count = params.has("types") ? 999 : 2;
      return {
        total: count,
        producedByAgentSessions: count,
        updatedInWindow: 1,
        neverEdited: 0,
        windowDays: 7,
      };
    });
    const summary = await readDocumentSummaryWithSubtypeUnion(
      { get } as unknown as ApiClient,
      { types },
      (body) => body as DocumentListSummary
    );
    expect(summary).toMatchObject({
      total: 6,
      producedByAgentSessions: 6,
      updatedInWindow: 3,
    });
    expect(get).toHaveBeenCalledTimes(4);
  });

  it("keeps unbounded results restricted if an old server silently ignores types", async () => {
    const get = vi
      .fn()
      .mockResolvedValue([
        createMockDocument({ type: DocumentType.Doc }),
        createMockDocument({ type: DocumentType.Feature }),
      ]);
    const rows = await readDocumentsWithSubtypeUnion(
      { get } as unknown as ApiClient,
      { types }
    );
    expect(rows.map((row) => row.type)).toEqual([DocumentType.Doc]);
  });
});

const types = [
  DocumentType.Prd,
  DocumentType.ImplementationPlan,
  DocumentType.Doc,
];
