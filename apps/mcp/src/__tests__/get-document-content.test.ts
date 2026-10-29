import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import { type ZodRawShape, z } from "zod";
import type { ApiClient } from "../api-client.js";
import { registerGetDocumentContent } from "../tools/get-document-content.js";
import {
  createToolHarnessWithMock,
  parseToolPayload,
  registeredInputSchema,
} from "./fixtures/tool-harness.js";
import { expectIssue, ZodIssueCode } from "./fixtures/zod-issues.js";

describe("get-document-content MCP tool", () => {
  it("retrieves the latest body with exact terminal metadata", async () => {
    const content = "hello 漢😀";
    const { get, handler } = makeHarness(
      makeDocumentResponse({ content, version: 3 })
    );

    const result = await handler({ documentId: "ISS-42" });
    const payload = parseExactPayload(result);

    expect(get).toHaveBeenCalledWith("/documents/ISS-42");
    expect(payload).toEqual({
      documentId: DOCUMENT_ID,
      resolvedVersion: 3,
      content,
      byteStart: 0,
      byteEndExclusive: Buffer.byteLength(content, "utf8"),
      returnedBytes: Buffer.byteLength(content, "utf8"),
      totalBytes: Buffer.byteLength(content, "utf8"),
      contentSha256: sha256(content),
      nextCursor: null,
    });
    expect(structuredPayload(result)).toEqual(payload);
  });

  it("retrieves an explicitly requested historical version", async () => {
    const { get, handler } = makeHarness(
      makeDocumentResponse({ content: "historical", version: 2 })
    );

    const payload = parseExactPayload(
      await handler({ documentId: "PLN-7", version: 2 })
    );

    expect(get).toHaveBeenCalledWith("/documents/PLN-7", { version: "2" });
    expect(payload.resolvedVersion).toBe(2);
    expect(payload.content).toBe("historical");
  });

  it("reconstructs more than 120k multibyte characters without mixing a new latest version", async () => {
    const original = `${"a".repeat(120_001)}${"漢😀".repeat(2000)}`;
    const newer = "a later latest version";
    let latestVersion = 4;
    const get = vi.fn(
      (_path: string, query?: Record<string, string | readonly string[]>) => {
        const requested = query?.version;
        const version =
          typeof requested === "string" ? Number(requested) : latestVersion;
        return Promise.resolve(
          makeDocumentResponse({
            content: version === 4 ? original : newer,
            version,
          })
        );
      }
    );
    const { handler } = makeHarnessWithGet(get);
    const chunks: Buffer[] = [];
    let cursor: string | null = null;
    let expectedStart = 0;

    do {
      const payload = parseExactPayload(
        await handler({
          documentId: "ISS-42",
          chunkSizeBytes: 8191,
          ...(cursor === null ? {} : { cursor }),
        })
      );
      expect(payload.byteStart).toBe(expectedStart);
      expect(payload.returnedBytes).toBe(
        payload.byteEndExclusive - payload.byteStart
      );
      expect(payload.returnedBytes).toBeLessThanOrEqual(8191);
      expect(Buffer.byteLength(payload.content, "utf8")).toBe(
        payload.returnedBytes
      );
      expect(payload.resolvedVersion).toBe(4);
      expect(payload.contentSha256).toBe(sha256(original));
      chunks.push(Buffer.from(payload.content, "utf8"));
      expectedStart = payload.byteEndExclusive;
      cursor = payload.nextCursor;
      latestVersion = 5;
    } while (cursor !== null);

    expect(original.length).toBeGreaterThan(120_000);
    expect(Buffer.concat(chunks).toString("utf8")).toBe(original);
    expect(expectedStart).toBe(Buffer.byteLength(original, "utf8"));
    expect(get.mock.calls[0]?.[1]).toBeUndefined();
    for (const call of get.mock.calls.slice(1)) {
      expect(call[1]).toEqual({ version: "4" });
    }
  });

  it("uses scalar-safe half-open ranges at multibyte boundaries", async () => {
    const content = "ab😀漢cd";
    const { handler } = makeHarness(
      makeDocumentResponse({ content, version: 1 })
    );

    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 5 })
    );
    const second = parseExactPayload(
      await handler({
        documentId: "ISS-42",
        cursor: first.nextCursor ?? "",
        chunkSizeBytes: 5,
      })
    );

    expect(first.content).toBe("ab");
    expect(first.byteStart).toBe(0);
    expect(first.byteEndExclusive).toBe(2);
    expect(second.content).toBe("😀");
    expect(second.byteStart).toBe(2);
    expect(second.byteEndExclusive).toBe(6);
  });

  it("fails when the next UTF-8 scalar cannot fit the requested budget", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "😀", version: 1 })
    );

    const result = await handler({
      documentId: "ISS-42",
      chunkSizeBytes: 1,
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "too small to include the next complete UTF-8 scalar"
    );
  });

  it("treats a changed valid offset as an allowed caller-selected gap", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "abcdef", version: 1 })
    );
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 2 })
    );
    const cursor = mutateCursor(first.nextCursor ?? "", {
      nextByteOffset: 4,
    });

    const continued = parseExactPayload(
      await handler({ documentId: "ISS-42", cursor, chunkSizeBytes: 2 })
    );

    expect(continued.byteStart).toBe(4);
    expect(continued.content).toBe("ef");
    expect(continued.nextCursor).toBeNull();
  });

  it("rejects a cursor offset inside a UTF-8 scalar", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "a😀b", version: 1 })
    );
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 1 })
    );
    const cursor = mutateCursor(first.nextCursor ?? "", {
      nextByteOffset: 2,
    });

    const result = await handler({ documentId: "ISS-42", cursor });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("not on a UTF-8 scalar boundary");
  });

  it("rejects a cursor offset outside the document", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "abcdef", version: 1 })
    );
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 2 })
    );
    const cursor = mutateCursor(first.nextCursor ?? "", {
      nextByteOffset: 99,
    });

    const result = await handler({ documentId: "ISS-42", cursor });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("outside the document");
  });

  it("rejects malformed, non-schema, and oversized cursors", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "abcdef", version: 1 })
    );
    const unknownFieldCursor = Buffer.from(
      JSON.stringify({ unexpected: true }),
      "utf8"
    ).toString("base64url");

    for (const cursor of ["%%%", unknownFieldCursor, "a".repeat(2049)]) {
      const result = await handler({ documentId: "ISS-42", cursor });
      expect(result.isError).toBe(true);
    }
  });

  it("rejects conflicting cursor and version selectors", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "abcdef", version: 1 })
    );
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 2 })
    );

    const result = await handler({
      documentId: "ISS-42",
      version: 1,
      cursor: first.nextCursor ?? "",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "cursor and version cannot be supplied together"
    );
  });

  it.each([
    { input: { chunkSizeBytes: 65_537 }, message: "chunkSizeBytes" },
    { input: { chunkSizeBytes: 0 }, message: "chunkSizeBytes" },
    { input: { version: 0 }, message: "version must be a positive integer" },
  ])(
    "rejects invalid numeric input at handler runtime",
    async ({ input, message }) => {
      const { handler } = makeHarness(
        makeDocumentResponse({ content: "body", version: 1 })
      );

      const result = await handler({ documentId: "ISS-42", ...input });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(message);
    }
  );

  it("rejects digest changes for a cursor-pinned immutable version", async () => {
    let content = "original body";
    const get = vi.fn(() =>
      Promise.resolve(makeDocumentResponse({ content, version: 1 }))
    );
    const { handler } = makeHarnessWithGet(get);
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 4 })
    );
    content = "mutated body";

    const result = await handler({
      documentId: "ISS-42",
      cursor: first.nextCursor ?? "",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "digest does not match the selected immutable document version"
    );
  });

  it("rejects document and version mixing on continuation", async () => {
    const initial = makeDocumentResponse({ content: "abcdef", version: 1 });
    let response = initial;
    const get = vi.fn(() => Promise.resolve(response));
    const { handler } = makeHarnessWithGet(get);
    const first = parseExactPayload(
      await handler({ documentId: "ISS-42", chunkSizeBytes: 2 })
    );

    response = makeDocumentResponse({
      content: "abcdef",
      documentId: OTHER_DOCUMENT_ID,
      version: 2,
    });
    const result = await handler({
      documentId: "ISS-42",
      cursor: first.nextCursor ?? "",
    });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("resolved a different version");
  });

  it("rejects a version row that belongs to a different document", async () => {
    const response = makeDocumentResponse({ content: "body", version: 1 });
    response.version.documentId = OTHER_DOCUMENT_ID;
    const { handler } = makeHarness(response);

    const result = await handler({ documentId: "ISS-42" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain(
      "version documentId does not match the canonical document id"
    );
  });

  it.each([
    ["a slug", "ISS-42"],
    ["an overlong identifier", "a".repeat(3000)],
  ])(
    "rejects equal API identity fields when they contain %s",
    async (_label, documentId) => {
      const { handler } = makeHarness({
        id: documentId,
        version: { documentId, version: 1, content: "body" },
      });

      const result = await handler({ documentId: "ISS-42" });

      expect(result.isError).toBe(true);
      expect(result.content[0]?.text).toContain(
        "invalid exact-content response"
      );
    }
  );

  it("rejects nullable or malformed API bodies instead of fabricating content", async () => {
    const { handler } = makeHarness({
      id: DOCUMENT_ID,
      version: { documentId: DOCUMENT_ID, version: 1, content: null },
    });

    const result = await handler({ documentId: "ISS-42" });

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("invalid exact-content response");
  });

  it("returns an exact empty body as one terminal zero-byte response", async () => {
    const { handler } = makeHarness(
      makeDocumentResponse({ content: "", version: 1 })
    );

    const payload = parseExactPayload(await handler({ documentId: "ISS-42" }));

    expect(payload.content).toBe("");
    expect(payload.byteStart).toBe(0);
    expect(payload.byteEndExclusive).toBe(0);
    expect(payload.returnedBytes).toBe(0);
    expect(payload.totalBytes).toBe(0);
    expect(payload.nextCursor).toBeNull();
    expect(payload.contentSha256).toBe(sha256(""));
  });

  it("registers bounded input and matching structured output schemas", async () => {
    const { handler, registerTool } = makeHarness(
      makeDocumentResponse({ content: "body", version: 1 })
    );
    const inputSchema = registeredInputSchema(registerTool);
    const config = registerTool.mock.calls[0]?.[1] as {
      outputSchema: ZodRawShape;
    };

    expect(
      inputSchema.safeParse({
        documentId: "ISS-42",
        chunkSizeBytes: 65_536,
      }).success
    ).toBe(true);
    expectIssue(
      inputSchema.safeParse({ documentId: "ISS-42", chunkSizeBytes: 65_537 }),
      ["chunkSizeBytes"],
      {
        code: ZodIssueCode.TooBig,
        origin: "number",
        // The cap is module-private in get-document-content.ts, so it is
        // bracketed by the 65_536-accepted assertion above rather than named.
        allowUnpinnedBound: true,
      }
    );
    expect(
      inputSchema.safeParse({
        documentId: "ISS-42",
        cursor: "a".repeat(2048),
      }).success
    ).toBe(true);
    expectIssue(
      inputSchema.safeParse({
        documentId: "ISS-42",
        cursor: "a".repeat(2049),
      }),
      ["cursor"],
      {
        code: ZodIssueCode.TooBig,
        origin: "string",
        allowUnpinnedBound: true,
      }
    );

    const result = await handler({ documentId: "ISS-42" });
    const payload = parseExactPayload(result);
    expect(z.object(config.outputSchema).parse(payload)).toEqual(payload);
    expect(structuredPayload(result)).toEqual(payload);
  });
});

const DOCUMENT_ID = "019c2991-0bce-76bc-bc7e-a4750929f668";
const OTHER_DOCUMENT_ID = "019c2991-0bce-76bc-bc7e-a4750929f669";

function makeHarness(response: unknown) {
  const get = vi.fn().mockResolvedValue(response);
  return { get, ...makeHarnessWithGet(get) };
}

function makeHarnessWithGet(get: ReturnType<typeof vi.fn>) {
  const apiClient = { get } as unknown as ApiClient;
  const harness = createToolHarnessWithMock(
    registerGetDocumentContent,
    apiClient
  );
  return { get, ...harness };
}

function makeDocumentResponse({
  content,
  documentId = DOCUMENT_ID,
  version,
}: {
  content: string;
  documentId?: string;
  version: number;
}) {
  return {
    id: documentId,
    slug: "ISS-42",
    version: { documentId, version, content },
  };
}

function parseExactPayload(result: ToolResult): ExactPayload {
  return parseToolPayload(result) as ExactPayload;
}

function structuredPayload(result: ToolResult): unknown {
  return (result as ToolResult & { structuredContent?: unknown })
    .structuredContent;
}

function mutateCursor(cursor: string, patch: Record<string, unknown>): string {
  const decoded = JSON.parse(
    Buffer.from(cursor, "base64url").toString("utf8")
  ) as Record<string, unknown>;
  return Buffer.from(JSON.stringify({ ...decoded, ...patch }), "utf8").toString(
    "base64url"
  );
}

function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

type ToolResult = Awaited<
  ReturnType<ReturnType<typeof createToolHarnessWithMock>["handler"]>
>;

type ExactPayload = {
  documentId: string;
  resolvedVersion: number;
  content: string;
  byteStart: number;
  byteEndExclusive: number;
  returnedBytes: number;
  totalBytes: number;
  contentSha256: string;
  nextCursor: string | null;
};
