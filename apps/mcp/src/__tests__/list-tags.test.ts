import {
  TAG_LIST_DEFAULT_LIMIT,
  TAG_LIST_MAX_LIMIT,
  TagColor,
} from "@repo/api/src/types/tag.js";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ApiClient } from "../api-client.js";
import { registerListTags } from "../tools/list-tags.js";
import {
  createToolHarnessWithMock,
  parseToolPayload,
  registeredInputSchema,
  registeredToolConfig,
} from "./fixtures/tool-harness.js";
import { expectIssue, ZodIssueCode } from "./fixtures/zod-issues.js";

const TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbcca";
const OTHER_TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbccb";
const THIRD_TAG_ID = "019fae2d-27f1-7702-9921-5db4096cbccc";

type TagsPayload = {
  total: number;
  returned: number;
  hasMore: boolean;
  nextOffset: number | null;
  items: { id: string; name: string; color: string | null }[];
};

function harness(apiClient: ApiClient) {
  return createToolHarnessWithMock(registerListTags, apiClient);
}

describe("list-tags MCP tool", () => {
  const apiClient = { get: vi.fn() } as unknown as ApiClient;
  const get = apiClient.get as ReturnType<typeof vi.fn>;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("registers the exact tool name and states the surface is writable", () => {
    const { registerTool } = harness(apiClient);

    expect(registerTool).toHaveBeenCalledWith(
      "list-tags",
      expect.objectContaining({
        description: expect.stringContaining("READABLE AND WRITABLE"),
      }),
      expect.any(Function)
    );
  });

  it("names the sibling write tools so an agent knows tags can be applied", () => {
    const { registerTool } = harness(apiClient);
    const { description } = registeredToolConfig(registerTool);

    expect(description).toContain("tag-artifact");
    expect(description).toContain("untag-artifact");
    // list-tags is the discovery entry point, so it must also disclose that
    // writing a tag reaches GitHub and that removing it does not undo that.
    expect(description).toContain("GitHub");
    expect(description).toContain("does NOT retract");
  });

  // ISS-6967 exists because an agent concluded from a tool surface that tags
  // were not a concept. A description that calls a 25-item slice "every tag"
  // invites the same wrong conclusion one level down — "no DSP tag exists" —
  // so the description must name itself a page and say how to exhaust it.
  //
  // TAG_LIST_DEFAULT_LIMIT/TAG_LIST_MAX_LIMIT (25/100) are the constants
  // list-tags.ts actually reads. They currently equal the old tool-utils
  // DEFAULT_PAGE_LIMIT/MAX_PAGE_LIMIT (also 25/100) they replaced, so this
  // assertion is honest about the constant it names but cannot, by itself,
  // distinguish "reads TAG_LIST_*" from "still reads the retired pair and got
  // lucky" while the two happen to coincide — it becomes meaningful the
  // moment either pair's values diverge.
  it("calls itself a page and tells the caller to exhaust hasMore", () => {
    const { registerTool } = harness(apiClient);
    const { description } = registeredToolConfig(registerTool);

    expect(description).not.toContain("List every tag");
    expect(description).toContain("PAGE, not the whole catalogue");
    expect(description).toContain(String(TAG_LIST_DEFAULT_LIMIT));
    expect(description).toContain(String(TAG_LIST_MAX_LIMIT));
    expect(description).toContain("nextOffset until hasMore is false");
  });

  it("reads GET /tags and maps id, name, and color", async () => {
    get.mockResolvedValue([
      { id: TAG_ID, name: "agent-fleet", color: TagColor.Green, extra: "drop" },
    ]);
    const { handler } = harness(apiClient);

    const payload = (await handler({})) as never;

    expect(get).toHaveBeenCalledWith("/tags", expect.any(Object));
    expect(parseToolPayload(payload)).toMatchObject({
      total: 1,
      returned: 1,
      items: [{ id: TAG_ID, name: "agent-fleet", color: TagColor.Green }],
    });
  });

  // ISS-7461: the whole point of the rewrite is that this tool no longer
  // fetches the org's entire tag catalogue and slices it in memory — the
  // bounds travel to the server as query params. If a revert dropped the
  // params, `get` would go back to being called with just "/tags".
  it("forwards limit, offset, includeTotal, and search as the query argument", async () => {
    get.mockResolvedValue({ items: [], total: 0, hasMore: false });
    const { handler } = harness(apiClient);

    await handler({ limit: 10, offset: 20, search: "dsp" });

    expect(get).toHaveBeenCalledWith("/tags", {
      limit: "10",
      offset: "20",
      includeTotal: "true",
      search: "dsp",
    });
  });

  // Regression pin for buildPaginatedPayload's `page` mode: a server that
  // already sliced the page must not be re-sliced. Re-applying
  // `.slice(offset, offset + limit)` to a 2-row page requested at offset=25
  // yields an empty array, which would silently truncate every page after
  // the first.
  it("returns a middle page from the envelope without re-slicing", async () => {
    get.mockResolvedValue({
      items: [
        { id: TAG_ID, name: "agent-fleet", color: TagColor.Green },
        { id: OTHER_TAG_ID, name: "dsp", color: TagColor.Blue },
      ],
      total: 57,
      hasMore: true,
    });
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({ offset: 25, limit: 25 })) as never
    ) as TagsPayload;

    expect(payload.returned).toBe(2);
    expect(payload.items).toHaveLength(2);
    expect(payload.total).toBe(57);
    expect(payload.hasMore).toBe(true);
    // Advances by the requested PAGE SIZE, not by how many rows survived
    // shaping. The server skipped `limit` rows to build this page, so a short
    // page means rows were dropped locally, not that the window was smaller —
    // advancing by 2 would re-read 23 rows the caller already has, and a
    // fully-dropped page would leave nextOffset === offset with hasMore true,
    // which never terminates for an agent paging until hasMore is false.
    expect(payload.nextOffset).toBe(50);
  });

  it("returns a null nextOffset on the envelope's last page", async () => {
    get.mockResolvedValue({
      items: [{ id: TAG_ID, name: "agent-fleet", color: TagColor.Green }],
      total: 26,
      hasMore: false,
    });
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({ offset: 25, limit: 25 })) as never
    ) as TagsPayload;

    expect(payload.hasMore).toBe(false);
    expect(payload.nextOffset).toBeNull();
  });

  // Legacy skew: an old API ignores every query param and answers with the
  // whole catalogue as a bare array. Without a local filter this would hand
  // an agent an unfiltered page presented as search results.
  it("filters a legacy bare-array response by search locally", async () => {
    get.mockResolvedValue([
      { id: TAG_ID, name: "dsp-rollout", color: TagColor.Green },
      { id: OTHER_TAG_ID, name: "unrelated", color: TagColor.Blue },
      { id: THIRD_TAG_ID, name: "also-unrelated", color: TagColor.Amber },
    ]);
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({ search: "dsp" })) as never
    ) as TagsPayload;

    expect(payload.items).toEqual([
      { id: TAG_ID, name: "dsp-rollout", color: TagColor.Green },
    ]);
  });

  it("slices a legacy bare-array response locally by limit and offset", async () => {
    get.mockResolvedValue([
      { id: TAG_ID, name: "alpha", color: TagColor.Green },
      { id: OTHER_TAG_ID, name: "beta", color: TagColor.Blue },
      { id: THIRD_TAG_ID, name: "gamma", color: TagColor.Amber },
    ]);
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({ limit: 1, offset: 1 })) as never
    ) as TagsPayload;

    expect(payload.items).toEqual([
      { id: OTHER_TAG_ID, name: "beta", color: TagColor.Blue },
    ]);
    expect(payload.total).toBe(3);
    expect(payload.hasMore).toBe(true);
    expect(payload.nextOffset).toBe(2);
  });

  // The catalogue must not hide a tag whose colour is outside the palette:
  // `readTagSummaries` would drop it, which would make the tag unmatchable by
  // name and therefore impossible to apply. This case fails if someone swaps
  // the bespoke shaper for that helper.
  it("keeps a tag whose color is outside the palette", async () => {
    get.mockResolvedValue([
      { id: TAG_ID, name: "legacy", color: "chartreuse" },
      { id: OTHER_TAG_ID, name: "normal", color: TagColor.Blue },
    ]);
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({})) as never
    ) as TagsPayload;

    expect(payload.items).toEqual([
      { id: TAG_ID, name: "legacy", color: "chartreuse" },
      { id: OTHER_TAG_ID, name: "normal", color: TagColor.Blue },
    ]);
  });

  it("drops rows that cannot identify a tag and nulls a non-string color", async () => {
    get.mockResolvedValue([
      { id: TAG_ID, name: "keep", color: 42 },
      { id: OTHER_TAG_ID },
      { name: "no id", color: TagColor.Red },
      null,
    ]);
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({})) as never
    ) as TagsPayload;

    expect(payload.items).toEqual([{ id: TAG_ID, name: "keep", color: null }]);
    expect(payload.total).toBe(1);
  });

  it("surfaces a non-array /tags payload as an error instead of an empty list", async () => {
    get.mockResolvedValue({ unexpected: true });
    const { handler } = harness(apiClient);

    const result = (await handler({})) as { isError?: boolean };

    expect(result.isError).toBe(true);
  });

  it("reports the end of the list when offset runs past the last tag", async () => {
    get.mockResolvedValue([{ id: TAG_ID, name: "only", color: TagColor.Teal }]);
    const { handler } = harness(apiClient);

    const payload = parseToolPayload(
      (await handler({ offset: 5 })) as never
    ) as TagsPayload;

    expect(payload).toMatchObject({
      total: 1,
      returned: 0,
      hasMore: false,
      items: [],
    });
  });

  it("rejects out-of-range pagination at the registered input schema", () => {
    const { registerTool } = harness(apiClient);
    const inputSchema = registeredInputSchema(registerTool);

    expectIssue(inputSchema.safeParse({ limit: 0 }), ["limit"], {
      code: ZodIssueCode.TooSmall,
      origin: "number",
      minimum: 1,
    });
    expectIssue(
      inputSchema.safeParse({ limit: TAG_LIST_MAX_LIMIT + 1 }),
      ["limit"],
      {
        code: ZodIssueCode.TooBig,
        origin: "number",
        maximum: TAG_LIST_MAX_LIMIT,
      }
    );
    expectIssue(inputSchema.safeParse({ offset: -1 }), ["offset"], {
      code: ZodIssueCode.TooSmall,
      origin: "number",
      minimum: 0,
    });
    expect(inputSchema.safeParse({ limit: TAG_LIST_MAX_LIMIT }).success).toBe(
      true
    );
    expect(inputSchema.safeParse({}).success).toBe(true);
  });

  it("surfaces an API failure as an error result", async () => {
    get.mockRejectedValue(new Error("boom"));
    const { handler } = harness(apiClient);

    const result = (await handler({})) as {
      isError?: boolean;
      content: { text: string }[];
    };

    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toContain("boom");
  });
});
