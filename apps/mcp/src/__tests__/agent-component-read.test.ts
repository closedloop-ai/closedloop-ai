import { Harness } from "@repo/api/src/types/agent-component.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildAgentComponentListQuery,
  registerGetAgentComponent,
  registerListAgentComponents,
  shapeAgentComponentDetail,
  shapeAgentComponentListItem,
} from "../tools/agent-component-read.js";

describe("buildAgentComponentListQuery", () => {
  it("maps provided filters and stringifies pagination params", () => {
    expect(
      buildAgentComponentListQuery({
        collaborator: "Ada Lovelace",
        source: "closedloop-ai/symphony-alpha",
        harness: "claude",
        search: "review",
        startDate: "2026-07-01",
        endDate: "2026-07-31",
        sortBy: "invocations",
        sortDir: "desc",
        limit: 100,
        offset: 50,
      })
    ).toEqual({
      collaborator: "Ada Lovelace",
      source: "closedloop-ai/symphony-alpha",
      harness: "claude",
      search: "review",
      startDate: "2026-07-01",
      endDate: "2026-07-31",
      sortBy: "invocations",
      sortDir: "desc",
      limit: "100",
      offset: "50",
    });
  });

  // ISS-4942: FEA-4098 renamed the route filter `owner` → `collaborator`, and
  // the route's query schema is not `.strict()`, so a stale `owner=` param was
  // silently dropped and the filter returned the full unfiltered inventory.
  it("maps the deprecated owner input onto the collaborator query param", () => {
    expect(buildAgentComponentListQuery({ owner: "Ada Lovelace" })).toEqual({
      collaborator: "Ada Lovelace",
    });
  });

  it("prefers collaborator over the deprecated owner input when both are set", () => {
    expect(
      buildAgentComponentListQuery({
        collaborator: "Grace Hopper",
        owner: "Ada Lovelace",
      })
    ).toEqual({ collaborator: "Grace Hopper" });
  });

  it("falls back to owner when collaborator is blank rather than masking it", () => {
    expect(
      buildAgentComponentListQuery({
        collaborator: "  ",
        owner: "Ada Lovelace",
      })
    ).toEqual({ collaborator: "Ada Lovelace" });
  });

  it("omits a blank collaborator filter the route would reject", () => {
    expect(buildAgentComponentListQuery({ collaborator: "" })).toEqual({});
  });

  it("passes kinds through as an array so it serializes as a repeated param", () => {
    expect(
      buildAgentComponentListQuery({ kinds: ["skill", "subagent"] })
    ).toEqual({ kinds: ["skill", "subagent"] });
  });

  it("omits an empty kinds array rather than emitting a zero-kind filter", () => {
    expect(buildAgentComponentListQuery({ kinds: [] })).toEqual({});
  });

  it("keeps a zero offset instead of dropping it as undefined", () => {
    expect(buildAgentComponentListQuery({ offset: 0 })).toEqual({
      offset: "0",
    });
  });

  it("drops undefined filters and returns an empty query when nothing is set", () => {
    expect(buildAgentComponentListQuery({ harness: "codex" })).toEqual({
      harness: "codex",
    });
    expect(buildAgentComponentListQuery({})).toEqual({});
  });

  it("forwards the opencode harness filter (ISS-4386)", () => {
    // OpenCode is a first-class harness value now; the tool must forward it to
    // the API query, not silently drop it (shafty023).
    expect(buildAgentComponentListQuery({ harness: Harness.Opencode })).toEqual(
      { harness: "opencode" }
    );
  });
});

describe("shapeAgentComponentListItem", () => {
  it("projects the identifiers, inventory metadata, and usage metrics", () => {
    const shaped = shapeAgentComponentListItem({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "skill::code-review",
      name: "code-review",
      kind: "skill",
      sourceType: "repo",
      source: "closedloop-ai/symphony-alpha",
      harness: "claude",
      invocations: 42,
      sessions: 7,
      locPerDollar: 1.5,
      trend: [1, 2, 3],
      owner: "Ada Lovelace",
      collaborators: ["Grace Hopper"],
      computeTargetIds: ["44444444-4444-4444-4444-444444444444"],
      firstSeenAt: "2026-06-01T00:00:00.000Z",
      lastSeenAt: "2026-07-14T00:00:00.000Z",
      lastInvokedAt: "2026-07-13T00:00:00.000Z",
    });

    expect(shaped).toEqual({
      id: "33333333-3333-3333-3333-333333333333",
      slug: "skill::code-review",
      name: "code-review",
      kind: "skill",
      sourceType: "repo",
      source: "closedloop-ai/symphony-alpha",
      harness: "claude",
      invocations: 42,
      sessions: 7,
      locPerDollar: 1.5,
      owner: "Ada Lovelace",
      collaborators: ["Grace Hopper"],
      computeTargetIds: ["44444444-4444-4444-4444-444444444444"],
      firstSeenAt: "2026-06-01T00:00:00.000Z",
      lastSeenAt: "2026-07-14T00:00:00.000Z",
      lastInvokedAt: "2026-07-13T00:00:00.000Z",
    });
    // The sparkline is a table-surface concern; it is deliberately not echoed.
    expect(shaped).not.toHaveProperty("trend");
  });

  it("preserves nulls for absent usage metrics on configured-only kinds", () => {
    expect(
      shapeAgentComponentListItem({
        id: "55555555-5555-5555-5555-555555555555",
        slug: "config::settings-json",
        name: "settings.json",
        kind: "config",
        invocations: null,
        sessions: null,
        locPerDollar: null,
        owner: null,
      })
    ).toMatchObject({
      slug: "config::settings-json",
      invocations: null,
      sessions: null,
      locPerDollar: null,
      owner: null,
      // Absent on the row entirely (never invoked) — null, not undefined.
      lastInvokedAt: null,
      collaborators: [],
      computeTargetIds: [],
    });
  });
});

const DETAIL = {
  id: "66666666-6666-6666-6666-666666666666",
  slug: "skill::code-review",
  name: "code-review",
  kind: "skill",
  properties: { path: ".claude/skills/code-review.md", format: "md" },
  prompt: "live definition text",
  versions: [
    {
      hash: "hash-new",
      source: "closedloop-ai/symphony-alpha",
      format: "md",
      createdAt: "2026-07-10T00:00:00.000Z",
      isCurrent: true,
      content: "current revision body",
    },
    {
      hash: "hash-old",
      source: "closedloop-ai/symphony-alpha",
      format: "md",
      createdAt: "2026-06-01T00:00:00.000Z",
      isCurrent: false,
      content: "older revision body",
    },
  ],
  provenance: [{ computeTargetId: "77777777-7777-7777-7777-777777777777" }],
  usageSessions: [{ sessionId: "ses-1", invocationCount: 3 }],
  sessionsTab: [{ id: "ses-1" }],
  branchesTab: [{ id: "branch-1" }],
};

describe("shapeAgentComponentDetail", () => {
  it("withholds every revision body by default, keeping only sizes", () => {
    const shaped = shapeAgentComponentDetail(DETAIL);

    expect(shaped).not.toHaveProperty("prompt");
    expect(shaped.promptLength).toBe("current revision body".length);
    expect(shaped.versions).toEqual([
      {
        hash: "hash-new",
        source: "closedloop-ai/symphony-alpha",
        format: "md",
        createdAt: "2026-07-10T00:00:00.000Z",
        isCurrent: true,
        contentLength: "current revision body".length,
      },
      {
        hash: "hash-old",
        source: "closedloop-ai/symphony-alpha",
        format: "md",
        createdAt: "2026-06-01T00:00:00.000Z",
        isCurrent: false,
        contentLength: "older revision body".length,
      },
    ]);
    // The API caps the detail at 20 revisions x 256 KiB; echoing the bodies
    // would put ~5 MB of definition text in one MCP response.
    expect(JSON.stringify(shaped)).not.toContain("revision body");
  });

  it("drops the UI tab prefetch payloads and keeps the agent-relevant lanes", () => {
    const shaped = shapeAgentComponentDetail(DETAIL);

    expect(shaped).not.toHaveProperty("sessionsTab");
    expect(shaped).not.toHaveProperty("branchesTab");
    expect(shaped.properties).toEqual(DETAIL.properties);
    expect(shaped.provenance).toEqual(DETAIL.provenance);
    expect(shaped.usageSessions).toEqual(DETAIL.usageSessions);
    // The list projection is reused verbatim.
    expect(shaped.slug).toBe("skill::code-review");
  });

  it("returns the current revision body when includePrompt is set", () => {
    const shaped = shapeAgentComponentDetail(DETAIL, { includePrompt: true });

    expect(shaped.prompt).toBe("current revision body");
    expect(shaped.promptVersionHash).toBe("hash-new");
  });

  it("returns the requested historical revision for versionHash", () => {
    const shaped = shapeAgentComponentDetail(DETAIL, {
      includePrompt: true,
      versionHash: "hash-old",
    });

    expect(shaped.prompt).toBe("older revision body");
    expect(shaped.promptVersionHash).toBe("hash-old");
    expect(shaped.promptLength).toBe("older revision body".length);
  });

  it("truncates the body at promptMaxChars", () => {
    const shaped = shapeAgentComponentDetail(DETAIL, {
      includePrompt: true,
      promptMaxChars: 7,
    });

    expect(shaped.prompt).toBe("current...[truncated]");
    // promptLength reports the true size, not the truncated one, so a caller
    // can tell it got a partial read.
    expect(shaped.promptLength).toBe("current revision body".length);
  });

  it("falls back to the top-level prompt when no revision is current", () => {
    const shaped = shapeAgentComponentDetail(
      { ...DETAIL, versions: [] },
      { includePrompt: true }
    );

    expect(shaped.prompt).toBe("live definition text");
    expect(shaped.promptVersionHash).toBeNull();
    expect(shaped.versions).toEqual([]);
  });

  it("preserves a null prompt for configured-only kinds with no definition text", () => {
    const shaped = shapeAgentComponentDetail(
      { slug: "hook::pre-commit", versions: [], prompt: null },
      { includePrompt: true }
    );

    expect(shaped.prompt).toBeNull();
    expect(shaped.promptLength).toBe(0);
  });

  // ISS-5029 (wongk): this projection rebuilds the detail field-by-field, so it
  // dropped the truncation discriminator and returned a capped revision history
  // as if it were the complete one.
  it("forwards versionsTruncated when the API marks the history partial", () => {
    const shaped = shapeAgentComponentDetail({
      ...DETAIL,
      versionsTruncated: true,
    });

    expect(shaped.versionsTruncated).toBe(true);
  });

  it("omits versionsTruncated entirely when the API did not send it", () => {
    // True-only contract: absent means "complete", and a `false` would be a new
    // key an unaware caller never saw before.
    const shaped = shapeAgentComponentDetail(DETAIL);

    expect(Object.hasOwn(shaped, "versionsTruncated")).toBe(false);
  });

  it("never infers versionsTruncated from the revision count", () => {
    const shaped = shapeAgentComponentDetail({
      ...DETAIL,
      versionsTruncated: false,
    });

    expect(Object.hasOwn(shaped, "versionsTruncated")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Branch coverage: shapeAgentComponentDetail absent/null versions (L311) and
// null content (L351) are not exercised by the unit tests above because DETAIL
// always has a well-formed versions array with non-null content.
// ---------------------------------------------------------------------------

describe("shapeAgentComponentDetail — absent or null versions", () => {
  it("treats versions as an empty array when the API response has no versions field", () => {
    // Covers the false arm of Array.isArray(row.versions) (L311).
    // Use prompt: null too so promptLength is predictably 0 (avoids fallback to
    // the top-level prompt string in DETAIL).
    const shaped = shapeAgentComponentDetail({
      ...DETAIL,
      versions: null,
      prompt: null,
    });

    expect(shaped.versions).toEqual([]);
    expect(shaped.promptLength).toBe(0);
  });

  it("reports contentLength 0 for a version whose content is null", () => {
    // Covers the right arm of readString(entry.content)?.length ?? 0 (L351).
    const shaped = shapeAgentComponentDetail({
      ...DETAIL,
      versions: [
        {
          hash: "hash-null-content",
          source: "closedloop-ai/symphony-alpha",
          format: "md",
          createdAt: "2026-07-10T00:00:00.000Z",
          isCurrent: true,
          content: null,
        },
      ],
    });

    expect(shaped.versions[0].contentLength).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// ISS-4942 (wongk): the `buildAgentComponentListQuery` unit tests above never
// cross the REGISTERED tool boundary, so `collaborator` could vanish from the
// declared input schema — or the handler could stop routing input through the
// mapper — with every one of them still green. These drive the real
// `registerListAgentComponents` registration and assert the ApiClient call.
// ---------------------------------------------------------------------------

const registerTool = vi.fn();
const apiClient = { get: vi.fn() };

function registeredListHandler() {
  return registerTool.mock.calls[0]?.[2] as (
    input: Record<string, unknown>
  ) => Promise<unknown>;
}

describe("list-agent-components registered tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    apiClient.get.mockResolvedValue({ items: [], total: 0, hasMore: false });
    registerListAgentComponents({ registerTool } as never, apiClient as never);
  });

  it("declares both the collaborator filter and its deprecated owner alias", () => {
    const schema = registerTool.mock.calls[0]?.[1]?.inputSchema as Record<
      string,
      unknown
    >;

    expect(Object.keys(schema)).toContain("collaborator");
    expect(Object.keys(schema)).toContain("owner");
  });

  it("sends the collaborator filter through to the API client", async () => {
    await registeredListHandler()({ collaborator: "Grace Hopper" });

    expect(apiClient.get).toHaveBeenCalledWith(
      "/agent-components",
      expect.objectContaining({ collaborator: "Grace Hopper" })
    );
  });

  it("maps the deprecated owner input onto the collaborator query param", async () => {
    await registeredListHandler()({ owner: "Ada Lovelace" });

    const [path, query] = apiClient.get.mock.calls[0];
    expect(path).toBe("/agent-components");
    expect(query).toEqual({ collaborator: "Ada Lovelace" });
  });

  it("prefers collaborator over owner when the caller supplies both", async () => {
    await registeredListHandler()({
      collaborator: "Grace Hopper",
      owner: "Ada Lovelace",
    });

    expect(apiClient.get.mock.calls[0][1]).toEqual({
      collaborator: "Grace Hopper",
    });
  });

  it("falls back to an empty items array when the API response has no items field", async () => {
    // Covers the false arm of Array.isArray(record.items) (L255).
    apiClient.get.mockResolvedValue({ total: 0, hasMore: false });

    const result = await registeredListHandler()({});
    const payload = JSON.parse(
      (result as { content: { text: string }[] }).content[0].text
    );

    expect(payload.items).toEqual([]);
    expect(payload.returned).toBe(0);
  });

  it("falls back to items.length for total when the API response total is not a number", async () => {
    // Covers the right arm of readNumber(record.total) ?? items.length (L259).
    apiClient.get.mockResolvedValue({
      items: [{ id: "c-1", slug: "skill::code-review", kind: "skill" }],
      hasMore: false,
    });

    const result = await registeredListHandler()({});
    const payload = JSON.parse(
      (result as { content: { text: string }[] }).content[0].text
    );

    expect(payload.total).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// ISS-5029 (wongk): the truncation discriminator has to survive all the way to
// the JSON text the MCP client actually reads, so these drive the registered
// `get-agent-component` handler and parse its emitted payload.
// ---------------------------------------------------------------------------

type ToolTextResult = { content: { type: string; text: string }[] };

function registeredGetHandler() {
  return registerTool.mock.calls[0]?.[2] as (
    input: Record<string, unknown>
  ) => Promise<ToolTextResult>;
}

async function getAgentComponentPayload(): Promise<Record<string, unknown>> {
  const result = await registeredGetHandler()({ slug: "skill::code-review" });
  return JSON.parse(result.content[0].text);
}

describe("get-agent-component registered tool", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    registerGetAgentComponent({ registerTool } as never, apiClient as never);
  });

  it("emits versionsTruncated when the API marks the history partial", async () => {
    apiClient.get.mockResolvedValue({ ...DETAIL, versionsTruncated: true });

    const payload = await getAgentComponentPayload();

    expect(payload.versionsTruncated).toBe(true);
  });

  it("omits versionsTruncated when the API did not send it", async () => {
    apiClient.get.mockResolvedValue(DETAIL);

    const payload = await getAgentComponentPayload();

    expect(Object.hasOwn(payload, "versionsTruncated")).toBe(false);
  });
});
