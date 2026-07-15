import { afterEach, describe, expect, it, vi } from "vitest";
import { McpApiError } from "../api-error.js";
import {
  buildDocumentUrl,
  buildDocumentUrlFromRecord,
  buildLoopUrl,
  buildPaginatedPayload,
  extractArrayItems,
  setSessionOrgSlug,
  withErrorHandling,
} from "../tools/tool-utils.js";

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

describe("buildDocumentUrl", () => {
  it("builds a URL for PRD documents", () => {
    const url = buildDocumentUrl("PRD-7", "PRD");
    expect(url).toBe("https://app.closedloop.ai/prds/PRD-7");
  });

  it("builds a URL for IMPLEMENTATION_PLAN documents", () => {
    const url = buildDocumentUrl("PLN-4", "IMPLEMENTATION_PLAN");
    expect(url).toBe("https://app.closedloop.ai/implementation-plans/PLN-4");
  });

  it("builds a URL for FEATURE documents", () => {
    const url = buildDocumentUrl("FEA-42", "FEATURE");
    expect(url).toBe("https://app.closedloop.ai/features/FEA-42");
  });

  it("falls back to /documents/ prefix for TEMPLATE type", () => {
    const url = buildDocumentUrl("TPL-1", "TEMPLATE");
    expect(url).toBe("https://app.closedloop.ai/documents/TPL-1");
  });

  it("falls back to /documents/ prefix for unknown type", () => {
    const url = buildDocumentUrl("DOC-1", "UNKNOWN_TYPE");
    expect(url).toBe("https://app.closedloop.ai/documents/DOC-1");
  });

  it("encodes special characters in slug", () => {
    const url = buildDocumentUrl("../../admin", "PRD");
    expect(url).toBe("https://app.closedloop.ai/prds/..%2F..%2Fadmin");
  });
});

describe("buildDocumentUrlFromRecord", () => {
  it("builds URL when slug and type are present", () => {
    const url = buildDocumentUrlFromRecord({
      slug: "FEA-42",
      type: "FEATURE",
    });
    expect(url).toBe("https://app.closedloop.ai/features/FEA-42");
  });

  it("returns null when slug is missing", () => {
    expect(buildDocumentUrlFromRecord({ type: "FEATURE" })).toBeNull();
  });

  it("returns null when type is missing", () => {
    expect(buildDocumentUrlFromRecord({ slug: "FEA-42" })).toBeNull();
  });

  it("returns null for empty record", () => {
    expect(buildDocumentUrlFromRecord({})).toBeNull();
  });
});

describe("buildLoopUrl", () => {
  it("builds a URL with a UUID", () => {
    const id = "019abc12-3456-7890-abcd-ef0123456789";
    const url = buildLoopUrl(id);
    expect(url).toBe(`https://app.closedloop.ai/loops/${id}`);
  });

  it("encodes special characters in loop ID", () => {
    const url = buildLoopUrl("../evil");
    expect(url).toBe("https://app.closedloop.ai/loops/..%2Fevil");
  });
});

describe("org-scoped URLs via setSessionOrgSlug", () => {
  afterEach(() => {
    // Reset to no org slug by importing a fresh module would be ideal,
    // but for simplicity we set it back to a known state
    setSessionOrgSlug("");
  });

  it("includes org slug in document URLs when set", () => {
    setSessionOrgSlug("acme");
    expect(buildDocumentUrl("FEA-42", "FEATURE")).toBe(
      "https://app.closedloop.ai/acme/features/FEA-42"
    );
  });

  it("includes org slug in loop URLs when set", () => {
    setSessionOrgSlug("acme");
    expect(buildLoopUrl("abc-123")).toBe(
      "https://app.closedloop.ai/acme/loops/abc-123"
    );
  });

  it("includes org slug in buildDocumentUrlFromRecord", () => {
    setSessionOrgSlug("acme");
    expect(buildDocumentUrlFromRecord({ slug: "PRD-7", type: "PRD" })).toBe(
      "https://app.closedloop.ai/acme/prds/PRD-7"
    );
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

    expect(mod.buildLoopUrl("abc")).toBe(
      "https://custom.example.com/loops/abc"
    );
    expect(mod.buildDocumentUrl("FEA-1", "FEATURE")).toBe(
      "https://custom.example.com/features/FEA-1"
    );
  });

  it("strips trailing slashes from WEBAPP_URL", async () => {
    vi.stubEnv("WEBAPP_URL", "https://custom.example.com///");
    vi.resetModules();

    const mod = await import("../tools/tool-utils.js");

    expect(mod.buildLoopUrl("abc")).toBe(
      "https://custom.example.com/loops/abc"
    );
  });

  it("falls back to https://app.closedloop.ai when WEBAPP_URL is undefined", async () => {
    vi.unstubAllEnvs();
    delete process.env.WEBAPP_URL;
    vi.resetModules();

    const mod = await import("../tools/tool-utils.js");

    expect(mod.buildLoopUrl("abc")).toBe("https://app.closedloop.ai/loops/abc");
  });
});
