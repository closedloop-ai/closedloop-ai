import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import {
  DocumentType,
  DocumentTypeAlias,
} from "@repo/api/src/types/document.js";
import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import type { ApiClient } from "../api-client.js";
import {
  PROJECT_BOUND_DOCUMENT_TYPE_INPUTS,
  projectBoundDocumentTypeInputSchema,
  registerCreateDocument,
} from "../tools/create-document.js";
import { registerListDocuments } from "../tools/list-documents.js";
import {
  createUrlBuilder,
  DOCUMENT_DOC_HELP,
  type McpUrlBuilder,
} from "../tools/tool-utils.js";

// ISS-4397: the MCP create/list document tools accept `ISSUE` in addition to the
// legacy `FEATURE`, normalizing the alias to the persisted FEATURE subtype so
// both resolve to the same artifacts. These tests drive the real registered tool
// schemas AND handlers rather than asserting on source text, so the suite fails
// if either tool stops forwarding the normalized FEATURE to the API request.

type RegisteredTool = {
  description?: string;
  inputSchema: Record<string, z.ZodTypeAny>;
  handler: (...args: unknown[]) => Promise<unknown>;
};

/**
 * Capture the description, input schema AND handler that a tool registers by
 * spying on `McpServer.registerTool`. Runs the given register function and
 * returns all three so tests can assert the registered description, parse raw
 * args through the exact registered schema, and then drive the real handler with
 * the parsed input.
 */
function captureTool(
  register: (
    server: McpServer,
    apiClient: ApiClient,
    urls: McpUrlBuilder
  ) => void,
  apiClient: ApiClient
): RegisteredTool {
  let captured: RegisteredTool | undefined;
  const spy = vi.spyOn(McpServer.prototype, "registerTool").mockImplementation(
    (
      _name: string,
      config: {
        description?: string;
        inputSchema?: Record<string, z.ZodTypeAny>;
      },
      handler: (...args: unknown[]) => Promise<unknown>
    ) => {
      if (config.inputSchema) {
        captured = {
          description: config.description,
          inputSchema: config.inputSchema,
          handler,
        };
      }
      return undefined as never;
    }
  );
  const server = new McpServer({ name: "test", version: "0.0.0" });
  register(
    server,
    apiClient,
    createUrlBuilder(() => null)
  );
  spy.mockRestore();
  if (!captured) {
    throw new Error("tool did not register an input schema");
  }
  return captured;
}

/**
 * Parse raw tool arguments through the exact object schema the SDK builds from
 * the tool's `inputSchema`, then invoke the captured handler — mirroring the
 * SDK's parse-then-dispatch so the assertion covers the full production handoff.
 */
async function driveTool(
  tool: RegisteredTool,
  rawArgs: Record<string, unknown>
): Promise<void> {
  const parsed = z.object(tool.inputSchema).parse(rawArgs);
  const result = (await tool.handler(parsed, {})) as {
    isError?: boolean;
    content?: { text?: string }[];
  };
  // withErrorHandling converts handler throws into isError results, so a
  // silently-broken handler would otherwise leave every drive false-green.
  if (result?.isError) {
    throw new Error(
      `tool handler errored: ${result.content?.[0]?.text ?? "unknown"}`
    );
  }
}

describe("create-document accepts the ISSUE alias (ISS-4397)", () => {
  it("normalizes ISSUE to the persisted FEATURE subtype", () => {
    expect(
      projectBoundDocumentTypeInputSchema.parse(DocumentTypeAlias.Issue)
    ).toBe(DocumentType.Feature);
  });

  it("still accepts FEATURE unchanged (compat alias)", () => {
    expect(
      projectBoundDocumentTypeInputSchema.parse(DocumentType.Feature)
    ).toBe(DocumentType.Feature);
  });

  it("accepts PRD and IMPLEMENTATION_PLAN unchanged", () => {
    expect(projectBoundDocumentTypeInputSchema.parse(DocumentType.Prd)).toBe(
      DocumentType.Prd
    );
    expect(
      projectBoundDocumentTypeInputSchema.parse(DocumentType.ImplementationPlan)
    ).toBe(DocumentType.ImplementationPlan);
  });

  it("rejects org-level types (DOC/TEMPLATE) and unknown types", () => {
    expect(
      projectBoundDocumentTypeInputSchema.safeParse(DocumentType.Doc).success
    ).toBe(false);
    expect(
      projectBoundDocumentTypeInputSchema.safeParse(DocumentType.Template)
        .success
    ).toBe(false);
    expect(projectBoundDocumentTypeInputSchema.safeParse("EPIC").success).toBe(
      false
    );
  });

  it("lists ISSUE alongside the canonical project-bound inputs", () => {
    expect(PROJECT_BOUND_DOCUMENT_TYPE_INPUTS).toContain(
      DocumentTypeAlias.Issue
    );
    expect(PROJECT_BOUND_DOCUMENT_TYPE_INPUTS).toContain(DocumentType.Feature);
  });

  it("POSTs FEATURE to /documents when the caller passes type=ISSUE", async () => {
    const post = vi.fn().mockResolvedValue({ id: "doc-1", webUrl: null });
    const apiClient = { post } as unknown as ApiClient;
    const tool = captureTool(registerCreateDocument, apiClient);

    await driveTool(tool, {
      title: "Broken login",
      type: DocumentTypeAlias.Issue,
      projectId: "PRO-7",
      content: "steps to repro",
    });

    expect(post).toHaveBeenCalledTimes(1);
    const [path, body] = post.mock.calls[0];
    expect(path).toBe("/documents");
    expect((body as { type: string }).type).toBe(DocumentType.Feature);
  });

  it("POSTs FEATURE unchanged when the caller passes type=FEATURE (compat)", async () => {
    const post = vi.fn().mockResolvedValue({ id: "doc-2", webUrl: null });
    const apiClient = { post } as unknown as ApiClient;
    const tool = captureTool(registerCreateDocument, apiClient);

    await driveTool(tool, {
      title: "Existing feature",
      type: DocumentType.Feature,
      projectId: "PRO-7",
      content: "body",
    });

    const [, body] = post.mock.calls[0];
    expect((body as { type: string }).type).toBe(DocumentType.Feature);
  });
});

describe("list-documents accepts the ISSUE type filter (ISS-4397)", () => {
  it("advertises the Issue vocabulary (ISS-*) and no retired FEA-* terminology", () => {
    const tool = captureTool(registerListDocuments, {
      get: vi.fn(),
    } as unknown as ApiClient);
    // Reuses the shared help so the two surfaces cannot drift.
    expect(tool.description).toContain(DOCUMENT_DOC_HELP);
    expect(tool.description).toContain("`ISSUE`≡`FEATURE`");
    // The old copy steered models toward retired user-facing terminology.
    expect(tool.description).not.toContain("features (FEA-*)");
  });

  it("normalizes a type=ISSUE filter to FEATURE", () => {
    const tool = captureTool(registerListDocuments, {
      get: vi.fn(),
    } as unknown as ApiClient);
    expect(
      z.object(tool.inputSchema).parse({ type: DocumentTypeAlias.Issue }).type
    ).toBe(DocumentType.Feature);
  });

  it("accepts type=FEATURE unchanged", () => {
    const tool = captureTool(registerListDocuments, {
      get: vi.fn(),
    } as unknown as ApiClient);
    expect(
      z.object(tool.inputSchema).parse({ type: DocumentType.Feature }).type
    ).toBe(DocumentType.Feature);
  });

  it("accepts every canonical type and rejects unknown types", () => {
    const tool = captureTool(registerListDocuments, {
      get: vi.fn(),
    } as unknown as ApiClient);
    for (const type of [
      DocumentType.Prd,
      DocumentType.ImplementationPlan,
      DocumentType.Template,
      DocumentType.Doc,
    ]) {
      expect(z.object(tool.inputSchema).parse({ type }).type).toBe(type);
    }
    expect(z.object(tool.inputSchema).safeParse({ type: "EPIC" }).success).toBe(
      false
    );
  });

  it("GETs /documents with type=FEATURE when the caller filters type=ISSUE", async () => {
    const get = vi.fn().mockResolvedValue([]);
    const apiClient = { get } as unknown as ApiClient;
    const tool = captureTool(registerListDocuments, apiClient);

    await driveTool(tool, {
      type: DocumentTypeAlias.Issue,
      includeParentArtifact: false,
    });

    // First GET is the /documents list; assert its query carries FEATURE.
    const documentsCall = get.mock.calls.find(
      ([path]) => path === "/documents"
    );
    expect(documentsCall).toBeDefined();
    const query = documentsCall?.[1] as { type?: string };
    expect(query.type).toBe(DocumentType.Feature);
  });
});
