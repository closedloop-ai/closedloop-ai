import { DocumentType } from "@repo/api/src/types/document.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { McpApiError } from "../api-error.js";
import {
  buildPaginatedPayload,
  createUrlBuilder,
  extractArrayItems,
  shapeParentArtifact,
  withErrorHandling,
} from "../tools/tool-utils.js";

const orglessUrls = createUrlBuilder(() => null);

describe("withErrorHandling", () => {
  it("returns friendly text for structured API errors", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject(
        new McpApiError("Pre-commit hook failed", {
          code: "PROCESS_FAILED",
          details: {
            action: "commit",
            category: "pre_commit_hook",
            hookType: "lint",
            stderrExcerpt: "eslint failed",
          },
        })
      )
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Pre-commit hook failed");
    expect(result.content[0]?.text).toContain("Remediation:");
    expect(result.content[0]?.text).toContain("Fix the lint errors");
    expect(result.content[0]?.text).toContain("Technical details:");
  });

  it("redacts raw upstream details/result from technical details", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject(
        new McpApiError("Query failed", {
          code: "PROCESS_FAILED",
          timestamp: "2026-07-04T00:00:00.000Z",
          details: {
            category: "git_command_failed",
            internalPath: "/srv/app/secrets/config.json",
            sqlFragment: "SELECT * FROM users WHERE token = 'sk_live_abc'",
          },
        })
      )
    );

    const text = result.content[0]?.text ?? "";
    expect(result.isError).toBe(true);
    // Safe scalar metadata is preserved.
    expect(text).toContain("Technical details:");
    expect(text).toContain("PROCESS_FAILED");
    expect(text).toContain("2026-07-04T00:00:00.000Z");
    // Raw upstream `details` payload is redacted.
    expect(text).not.toContain("/srv/app/secrets/config.json");
    expect(text).not.toContain("SELECT * FROM users");
    expect(text).not.toContain("internalPath");
  });

  it("maps legacy thrown Error values to fallback friendly output", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject(new Error("legacy raw failure"))
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Operation failed");
    expect(result.content[0]?.text).toContain("legacy raw failure");
  });

  it("maps a non-Error rejection to the Unknown error technical detail", async () => {
    const result = await withErrorHandling(() =>
      Promise.reject("bare string rejection")
    );

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("Unknown error");
  });
});

describe("extractArrayItems", () => {
  it("returns a bare array unchanged", () => {
    expect(extractArrayItems([1, 2, 3])).toEqual([1, 2, 3]);
  });

  it("unwraps a { data: [] } envelope", () => {
    expect(extractArrayItems({ data: ["a", "b"] })).toEqual(["a", "b"]);
  });

  it("includes the received type and payload sample for object shapes", () => {
    expect(() => extractArrayItems({ items: [1, 2] })).toThrow(
      'received type "object" (sample: {"items":[1,2]})'
    );
  });

  it("reports null and primitive payloads with their type", () => {
    expect(() => extractArrayItems(null)).toThrow(
      'received type "null" (sample: null)'
    );
    expect(() => extractArrayItems("nope")).toThrow(
      'received type "string" (sample: "nope")'
    );
  });

  it("truncates an oversized payload sample", () => {
    const big = { data: "x".repeat(500), note: "y".repeat(500) };
    let message = "";
    try {
      extractArrayItems(big);
    } catch (error) {
      message = error instanceof Error ? error.message : String(error);
    }
    expect(message).toContain('received type "object"');
    expect(message).toContain("...[truncated]");
  });

  it("falls back to String(value) when the payload is undefined", () => {
    expect(() => extractArrayItems(undefined)).toThrow(
      'received type "undefined" (sample: undefined)'
    );
  });

  it("detects a circular reference and replaces it with [Circular] in the sample", () => {
    const obj: Record<string, unknown> = { a: 1 };
    obj.self = obj;
    expect(() => extractArrayItems(obj)).toThrow("[Circular]");
  });

  it("truncates arrays longer than 5 items in the payload sample", () => {
    expect(() => extractArrayItems({ items: [1, 2, 3, 4, 5, 6, 7] })).toThrow(
      "more)"
    );
  });
});

describe("buildPaginatedPayload", () => {
  it("surfaces the received-shape context when the payload is not a list", () => {
    expect(() =>
      buildPaginatedPayload(
        { unexpected: true },
        { mapItem: (item: unknown) => item }
      )
    ).toThrow('received type "object" (sample: {"unexpected":true})');
  });
});

describe("buildDocumentUrlFromRecord route prefixes", () => {
  it("builds a URL for PRD documents", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "PRD-7",
      type: DocumentType.Prd,
    });
    expect(url).toBe("https://app.closedloop.ai/prds/PRD-7");
  });

  it("builds a URL for IMPLEMENTATION_PLAN documents", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "PLN-4",
      type: DocumentType.ImplementationPlan,
    });
    expect(url).toBe("https://app.closedloop.ai/implementation-plans/PLN-4");
  });

  // FEA-4137: FEATURE documents route under /issues/ (the FEA- slug is a compat
  // alias that still resolves; only the route path changed).
  it("builds a URL for FEATURE documents", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    expect(url).toBe("https://app.closedloop.ai/issues/FEA-42");
  });

  it("falls back to /documents/ prefix for TEMPLATE type", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "TPL-1",
      type: DocumentType.Template,
    });
    expect(url).toBe("https://app.closedloop.ai/documents/TPL-1");
  });

  it("falls back to /documents/ prefix for unknown type", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "DOC-1",
      type: "UNKNOWN_TYPE",
    });
    expect(url).toBe("https://app.closedloop.ai/documents/DOC-1");
  });

  it("encodes special characters in slug", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "../../admin",
      type: DocumentType.Prd,
    });
    expect(url).toBe("https://app.closedloop.ai/prds/..%2F..%2Fadmin");
  });
});

describe("buildDocumentUrlFromRecord", () => {
  it("builds URL when slug and type are present", () => {
    const url = orglessUrls.buildDocumentUrlFromRecord({
      slug: "FEA-42",
      type: DocumentType.Feature,
    });
    expect(url).toBe("https://app.closedloop.ai/issues/FEA-42");
  });

  it("returns null when slug is missing", () => {
    expect(
      orglessUrls.buildDocumentUrlFromRecord({ type: DocumentType.Feature })
    ).toBeNull();
  });

  it("returns null when type is missing", () => {
    expect(
      orglessUrls.buildDocumentUrlFromRecord({ slug: "FEA-42" })
    ).toBeNull();
  });

  it("returns null for empty record", () => {
    expect(orglessUrls.buildDocumentUrlFromRecord({})).toBeNull();
  });
});

describe("buildLoopUrl", () => {
  it("builds a URL with a UUID", () => {
    const id = "019abc12-3456-7890-abcd-ef0123456789";
    const url = orglessUrls.buildLoopUrl(id);
    expect(url).toBe(`https://app.closedloop.ai/loops/${id}`);
  });

  it("encodes special characters in loop ID", () => {
    const url = orglessUrls.buildLoopUrl("../evil");
    expect(url).toBe("https://app.closedloop.ai/loops/..%2Fevil");
  });
});

describe("org-scoped URLs via createUrlBuilder", () => {
  const acmeUrls = createUrlBuilder(() => "acme");

  it("includes org slug in document URLs", () => {
    expect(
      acmeUrls.buildDocumentUrlFromRecord({
        slug: "FEA-42",
        type: DocumentType.Feature,
      })
    ).toBe("https://app.closedloop.ai/acme/issues/FEA-42");
  });

  it("includes org slug in loop URLs", () => {
    expect(acmeUrls.buildLoopUrl("abc-123")).toBe(
      "https://app.closedloop.ai/acme/loops/abc-123"
    );
  });

  it("includes org slug in buildDocumentUrlFromRecord", () => {
    expect(
      acmeUrls.buildDocumentUrlFromRecord({
        slug: "PRD-7",
        type: DocumentType.Prd,
      })
    ).toBe("https://app.closedloop.ai/acme/prds/PRD-7");
  });

  // ISS-6570 regression: the slug is captured per builder (one per MCP
  // session). Creating a builder for another org must not change what an
  // existing builder emits — the module-global this replaced let whichever
  // tenant initialized a session last stamp its slug into every other
  // tenant's webUrl.
  it("keeps each builder's org slug independent of later builders", () => {
    const orgA = createUrlBuilder(() => "org-a");
    const orgB = createUrlBuilder(() => "org-b");
    expect(orgB.buildLoopUrl("abc")).toBe(
      "https://app.closedloop.ai/org-b/loops/abc"
    );
    expect(
      orgA.buildDocumentUrlFromRecord({ slug: "PRD-7", type: DocumentType.Prd })
    ).toBe("https://app.closedloop.ai/org-a/prds/PRD-7");
    expect(orgA.buildLoopUrl("abc")).toBe(
      "https://app.closedloop.ai/org-a/loops/abc"
    );
  });

  it("builds org-less URLs when the slug is null", () => {
    expect(
      createUrlBuilder(() => null).buildDocumentUrlFromRecord({
        slug: "PRD-7",
        type: DocumentType.Prd,
      })
    ).toBe("https://app.closedloop.ai/prds/PRD-7");
  });
});

describe("WEBAPP_URL env var fallback", () => {
  const savedWebappUrl = process.env.WEBAPP_URL;

  afterEach(() => {
    vi.unstubAllEnvs();
    vi.resetModules();
    if (savedWebappUrl === undefined) {
      delete process.env.WEBAPP_URL;
    } else {
      process.env.WEBAPP_URL = savedWebappUrl;
    }
  });

  it("uses WEBAPP_URL from environment when set", async () => {
    vi.stubEnv("WEBAPP_URL", "https://custom.example.com/");
    vi.resetModules();

    const mod = await import("../tools/tool-utils.js");

    expect(mod.createUrlBuilder(() => null).buildLoopUrl("abc")).toBe(
      "https://custom.example.com/loops/abc"
    );
    expect(
      mod
        .createUrlBuilder(() => null)
        .buildDocumentUrlFromRecord({
          slug: "FEA-1",
          type: DocumentType.Feature,
        })
    ).toBe("https://custom.example.com/issues/FEA-1");
  });

  it("strips trailing slashes from WEBAPP_URL", async () => {
    vi.stubEnv("WEBAPP_URL", "https://custom.example.com///");
    vi.resetModules();

    const mod = await import("../tools/tool-utils.js");

    expect(mod.createUrlBuilder(() => null).buildLoopUrl("abc")).toBe(
      "https://custom.example.com/loops/abc"
    );
  });

  it("falls back to https://app.closedloop.ai when WEBAPP_URL is undefined", async () => {
    vi.unstubAllEnvs();
    delete process.env.WEBAPP_URL;
    vi.resetModules();

    const mod = await import("../tools/tool-utils.js");

    expect(mod.createUrlBuilder(() => null).buildLoopUrl("abc")).toBe(
      "https://app.closedloop.ai/loops/abc"
    );
  });
});

describe("shapeParentArtifact", () => {
  it("fills null for every omitted parentArtifact field and for null link fields", () => {
    const result = shapeParentArtifact({
      parentArtifact: {},
      linkId: null,
      linkType: null,
      linkCreatedAt: null,
    });
    expect(result).toEqual({
      id: null,
      type: null,
      subtype: null,
      name: null,
      slug: null,
      externalUrl: null,
      linkId: null,
      linkType: null,
      linkCreatedAt: null,
    });
  });

  it("returns null when parentArtifact itself is null", () => {
    const result = shapeParentArtifact({
      parentArtifact: null,
      linkId: null,
      linkType: null,
      linkCreatedAt: null,
    });
    expect(result).toBeNull();
  });
});
