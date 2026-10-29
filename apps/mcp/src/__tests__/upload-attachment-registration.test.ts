import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  MAX_ATTACHMENT_FILE_SIZE_BYTES,
  MAX_MEDIA_FILE_SIZE_BYTES,
  MEDIA_MIME_TYPES,
} from "@repo/api/src/types/attachment.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { z } from "zod";
import { registerUploadAttachment } from "../tools/upload-attachment.js";
import { expectIssue, ZodIssueCode } from "./fixtures/zod-issues.js";

vi.mock("../api-client.js", () => ({
  verifyApiKey: vi.fn(),
  checkApiReachable: vi.fn(),
  createApiClient: vi.fn(() => ({})),
}));

vi.mock("@repo/database", () => {
  const withDb = Object.assign(
    async <T>(fn: (db: Record<string, never>) => Promise<T> | T): Promise<T> =>
      fn({}),
    {
      tx: async <T>(
        fn: (db: Record<string, never>) => Promise<T>
      ): Promise<T> => fn({}),
    }
  );
  return { withDb };
});

const ORIGINAL_ENV = { ...process.env };

const CONTEXT = {
  userId: "user_1",
  organizationId: "org_1",
  scopes: ["read", "write"] as const,
};
const TOOL_NAME = "upload-attachment";

async function registeredToolNames(grantedScopes: string[]): Promise<string[]> {
  process.env.INTERNAL_API_SECRET = "test-internal-secret";
  const { __testables } = await import("../index.js");
  const names: string[] = [];
  const spy = vi
    .spyOn(McpServer.prototype, "registerTool")
    .mockImplementation((name: string) => {
      names.push(name);
      return undefined as never;
    });
  try {
    await __testables.createMcpServer(CONTEXT, "sk_live_test", grantedScopes);
  } finally {
    spy.mockRestore();
  }
  return names;
}

describe("upload-attachment tool registration gating", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
  });

  it("registers upload-attachment only when the session has write scope", async () => {
    const withWrite = await registeredToolNames(["read", "write"]);
    expect(withWrite).toContain(TOOL_NAME);
  });

  it("withholds upload-attachment from read-only sessions", async () => {
    const readOnly = await registeredToolNames(["read"]);
    expect(readOnly).not.toContain(TOOL_NAME);
    expect(readOnly).toContain("list-attachments");
  });
});

describe("upload-attachment input schema", () => {
  it("admits a media-sized upload and rejects anything above the media ceiling", () => {
    // ISS-10415 / operator ruling 2026-09-17: the schema used to cap at
    // MAX_ATTACHMENT_FILE_SIZE_BYTES, which made the media path unreachable
    // through MCP — a `.mov` the API accepts could not even be declared. The
    // per-type narrowing (a non-media file is still limited to the document
    // ceiling) belongs to the API validator, which can see `mimeType`; a Zod
    // raw shape cannot. The document ceiling is asserted here only as the floor
    // this bound must clear.
    const localRegisterTool = vi.fn();
    const localApiClient = { post: vi.fn() };

    registerUploadAttachment(
      { registerTool: localRegisterTool } as never,
      localApiClient as never
    );

    const config = localRegisterTool.mock.calls[0]?.[1] as {
      inputSchema: z.ZodRawShape;
    };
    const inputSchema = z.object(config.inputSchema);
    const validInput = {
      entityId: "FEA-42",
      filename: "large.bin",
      mimeType: "application/octet-stream",
    };

    expect(MAX_MEDIA_FILE_SIZE_BYTES).toBeGreaterThan(
      MAX_ATTACHMENT_FILE_SIZE_BYTES
    );
    for (const mimeType of MEDIA_MIME_TYPES) {
      expect(
        inputSchema.safeParse({
          ...validInput,
          mimeType,
          sizeBytes: MAX_MEDIA_FILE_SIZE_BYTES,
        }).success
      ).toBe(true);
    }
    expect(
      inputSchema.safeParse({
        ...validInput,
        sizeBytes: MAX_ATTACHMENT_FILE_SIZE_BYTES + 1,
      }).success
    ).toBe(true);
    expectIssue(
      inputSchema.safeParse({
        ...validInput,
        sizeBytes: MAX_MEDIA_FILE_SIZE_BYTES + 1,
      }),
      ["sizeBytes"],
      {
        code: ZodIssueCode.TooBig,
        origin: "number",
        maximum: MAX_MEDIA_FILE_SIZE_BYTES,
      }
    );
    expect(localApiClient.post).not.toHaveBeenCalled();
  });
});

describe("upload-attachment handler — purpose field omission", () => {
  it("omits purpose from the POST body when purpose is not supplied", async () => {
    // Covers the false arm of ...(purpose ? { purpose } : {}) in the handler.
    const localRegisterTool = vi.fn();
    const localApiClient = { post: vi.fn() };

    registerUploadAttachment(
      { registerTool: localRegisterTool } as never,
      localApiClient as never
    );

    const handler = localRegisterTool.mock.calls[0]?.[2] as (
      input: Record<string, unknown>
    ) => Promise<unknown>;

    localApiClient.post.mockResolvedValue({
      attachmentId: "a-1",
      uploadUrl: "https://s3.example.com/upload",
    });

    await handler({
      entityId: "PRD-7",
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    });

    const [, body] = localApiClient.post.mock.calls[0] as [
      string,
      Record<string, unknown>,
    ];
    expect(body).not.toHaveProperty("purpose");
    expect(body).toMatchObject({
      filename: "report.pdf",
      mimeType: "application/pdf",
      sizeBytes: 4096,
    });
  });
});
