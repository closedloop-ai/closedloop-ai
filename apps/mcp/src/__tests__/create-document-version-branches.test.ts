import {
  AttachmentPurpose,
  buildInlineAttachmentRef,
} from "@repo/api/src/types/attachment.js";
import { DocumentStatus, DocumentType } from "@repo/api/src/types/document.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { registerCreateDocumentVersion } from "../tools/create-document-version.js";
import { createUrlBuilder } from "../tools/tool-utils.js";
import {
  createToolHarness,
  parseToolPayload,
} from "./fixtures/tool-harness.js";

vi.mock("@repo/observability/log", () => ({
  log: {
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    flush: vi.fn(),
  },
}));

const post = vi.fn();
const handler = createToolHarness(registerCreateDocumentVersion, {
  post,
} as never);
const BASE_INPUT = { documentId: "DOC-1", content: "body" };

type Output = {
  version?: Record<string, unknown>;
  inlineImages?: Record<string, unknown>[];
};

async function run(response: unknown): Promise<Output> {
  post.mockResolvedValueOnce(response);
  return parseToolPayload(await handler(BASE_INPUT)) as Output;
}

async function runStructured(response: unknown): Promise<unknown> {
  post.mockResolvedValueOnce(response);
  const result = (await handler(BASE_INPUT)) as { structuredContent?: unknown };
  return result.structuredContent;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("create-document-version version shaping", () => {
  it("carries createdById and createdAt strings through to the version", async () => {
    const output = await run({
      version: {
        id: "ver-1",
        createdById: "user-1",
        createdAt: "2026-01-01T00:00:00.000Z",
      },
    });

    expect(output.version).toEqual({
      id: "ver-1",
      createdById: "user-1",
      createdAt: "2026-01-01T00:00:00.000Z",
    });
  });
});

describe("create-document-version inline image shaping", () => {
  it("takes attachmentId from the nested attachment row when the top-level field is absent", async () => {
    const output = await run({
      inlineImages: [
        {
          placeholder: "img-1",
          markdownImage: "![a](attachment://att-9)",
          attachment: {
            id: "att-9",
            filename: "a.png",
            purpose: AttachmentPurpose.Inline,
          },
        },
      ],
    });

    expect(output.inlineImages?.[0]).toMatchObject({
      attachmentId: "att-9",
      attachmentRef: buildInlineAttachmentRef("att-9"),
    });
  });

  it("fills every missing string with an empty string and defaults the mime type", async () => {
    // pins current behavior; looks odd because an image row with no id at all
    // is shaped into an empty attachmentId and a ref built from "" instead of
    // being rejected, unlike create-document which throws on the same input.
    const output = await run({ inlineImages: [{}] });

    expect(output.inlineImages).toEqual([
      {
        placeholder: "",
        attachmentId: "",
        attachmentRef: buildInlineAttachmentRef(""),
        markdownImage: "",
        attachment: {
          id: "",
          artifactId: null,
          filename: "",
          mimeType: "image/png",
          sizeBytes: null,
          purpose: AttachmentPurpose.Inline,
          createdAt: null,
          createdById: null,
        },
      },
    ]);
  });
});

describe("create-document-version structured output keys", () => {
  it("maps every document field onto its own output key", async () => {
    const row = {
      id: "doc-1",
      organizationId: "org-1",
      projectId: "proj-1",
      slug: "PRD-7",
      title: "Title",
      type: DocumentType.Prd,
      status: DocumentStatus.Draft,
      priority: null,
      latestVersion: 4,
      fileName: "prd.md",
      createdById: "user-1",
      createdBy: { id: "user-1" },
      assigneeId: null,
      assignee: null,
      approverId: "user-2",
      approver: { id: "user-2" },
      repositorySnapshot: { sha: "abc" },
      templateForType: null,
      sortOrder: 3,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
      project: { id: "proj-1" },
      generationStatus: { state: "idle" },
      customFields: [],
      tags: [],
      latestVersionContent: "latest",
      version: { id: "ver-4", documentId: "doc-1", version: 4, content: "v4" },
    };

    const output = await runStructured(row);

    const { latestVersionContent, version, ...documentFields } = row;
    expect(output).toStrictEqual({
      ...documentFields,
      latestVersionContent,
      webUrl: createUrlBuilder(() => null).buildDocumentUrlFromRecord(row),
      versionContent: "latest",
      version,
    });
  });

  it("carries no undefined-valued keys when the version row lacks optional fields", async () => {
    const output = await runStructured({ version: { id: "ver-1" } });

    expect(output).toStrictEqual({ webUrl: null, version: { id: "ver-1" } });
  });
});
