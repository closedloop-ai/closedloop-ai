/**
 * ClosedLoopClient response-envelope handling (PR #3460 thread 6). `req` must
 * throw a clear error when a data-returning endpoint is missing `data` in its
 * envelope, instead of casting `undefined` to the typed result and crashing a
 * caller later. The comment/tag POSTs opt out (`requireData: false`).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { ClosedLoopClient } from "../src/clients/closedloop.js";

const CFG = { apiKey: "k", projectSlug: "proj", baseUrl: "https://api.test" };
const MISSING_DATA = /missing "data"/;
const ENVELOPE_ERROR = /nope/;
const GATEWAY_BODY = /gateway blew up/;
const STATUS_500 = /500/;

/** Stub `fetch` with a fixed OK/empty-data body and record every requested URL. */
function stubUrlCapture(): string[] {
  const calls: string[] = [];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string) => {
      calls.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        text: () =>
          Promise.resolve(JSON.stringify({ success: true, data: [] })),
      } as Response);
    })
  );
  return calls;
}

function stubFetch(body: string, ok = true, status = 200) {
  const fn = vi.fn(async () =>
    Promise.resolve({
      ok,
      status,
      text: async () => Promise.resolve(body),
    } as Response)
  );
  vi.stubGlobal("fetch", fn);
  return fn;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ClosedLoopClient envelope handling", () => {
  it("throws when a data-returning endpoint omits data", async () => {
    stubFetch(JSON.stringify({ success: true }));
    const client = new ClosedLoopClient(CFG);
    await expect(client.listTags()).rejects.toThrow(MISSING_DATA);
  });

  it("returns an empty array payload without throwing", async () => {
    stubFetch(JSON.stringify({ success: true, data: [] }));
    const client = new ClosedLoopClient(CFG);
    await expect(client.listTags()).resolves.toEqual([]);
  });

  it("tolerates a data-less envelope for a POST that opts out", async () => {
    stubFetch(JSON.stringify({ success: true }));
    const client = new ClosedLoopClient(CFG);
    await expect(client.addComment("slug", "hi")).resolves.toBeUndefined();
  });

  it("surfaces the envelope error on success:false", async () => {
    stubFetch(JSON.stringify({ success: false, error: "nope" }));
    const client = new ClosedLoopClient(CFG);
    await expect(client.listTags()).rejects.toThrow(ENVELOPE_ERROR);
  });
});

// FEA-4373 made `/documents` honor `limit` as a page size (it previously
// ignored it and returned everything). `listDocuments` must therefore follow
// the pages internally so callers like the open-finding dedup set still get the
// COMPLETE result, not a truncated first page.
describe("ClosedLoopClient.listDocuments pagination walk (FEA-4373)", () => {
  function doc(id: string): Record<string, string> {
    return { id, slug: id, type: "FEATURE", title: id, status: "TODO" };
  }

  function stubPages(pages: Record<string, string>[][]) {
    const calls: string[] = [];
    const fn = vi.fn((url: string) => {
      calls.push(url);
      const body = JSON.stringify({
        success: true,
        data: pages[calls.length - 1] ?? [],
      });
      return Promise.resolve({
        ok: true,
        status: 200,
        text: async () => Promise.resolve(body),
      } as Response);
    });
    vi.stubGlobal("fetch", fn);
    return calls;
  }

  it("follows offset pages until a short page and returns the concatenated set", async () => {
    const firstPage = Array.from({ length: 100 }, (_u, i) => doc(`a-${i}`));
    const secondPage = [doc("b-0"), doc("b-1")];
    const calls = stubPages([firstPage, secondPage]);
    const client = new ClosedLoopClient(CFG);

    const result = await client.listDocuments({ type: "FEATURE", limit: 100 });

    // Full page → keep going; partial second page → stop. Complete set returned.
    expect(result).toHaveLength(102);
    expect(calls).toHaveLength(2);
    expect(calls[0]).toContain("offset=0");
    expect(calls[0]).toContain("limit=100");
    expect(calls[1]).toContain("offset=100");
  });

  it("stops after a single request when the first page is already short", async () => {
    const calls = stubPages([[doc("only-0")]]);
    const client = new ClosedLoopClient(CFG);

    const result = await client.listDocuments({ type: "FEATURE", limit: 100 });

    expect(result).toHaveLength(1);
    expect(calls).toHaveLength(1);
  });

  it("bounds the walk at maxPages so a full-page corpus can't spin unbounded", async () => {
    const fullPage = Array.from({ length: 2 }, (_u, i) => doc(`x-${i}`));
    // Every page returns a full page → the walk must stop at maxPages, not loop.
    const calls = stubPages([fullPage, fullPage, fullPage, fullPage]);
    const client = new ClosedLoopClient(CFG);

    const result = await client.listDocuments({
      type: "FEATURE",
      limit: 2,
      maxPages: 3,
    });

    expect(calls).toHaveLength(3);
    expect(result).toHaveLength(6);
  });

  it("defaults the page size and page cap when the caller supplies neither", async () => {
    const calls = stubPages([[doc("only-0")]]);
    const client = new ClosedLoopClient(CFG);

    await client.listDocuments({ type: "FEATURE" });

    expect(calls[0]).toContain("limit=100");
    expect(calls[0]).toContain("offset=0");
  });

  it("passes an assigneeId filter through, and omits it when absent", async () => {
    const withAssignee = stubPages([[doc("a")]]);
    const client = new ClosedLoopClient(CFG);
    await client.listDocuments({ type: "FEATURE", assigneeId: "user-1" });
    expect(withAssignee[0]).toContain("assigneeId=user-1");

    const without = stubPages([[doc("a")]]);
    await new ClosedLoopClient(CFG).listDocuments({ type: "FEATURE" });
    expect(without[0]).not.toContain("assigneeId");
  });
});

describe("ClosedLoopClient configuration", () => {
  it("defaults to the production base URL when none is configured", async () => {
    const calls = stubUrlCapture();

    await new ClosedLoopClient({ apiKey: "k", projectSlug: "proj" }).listTags();

    expect(calls[0]).toContain("https://api.closedloop.ai/");
  });

  it("strips a trailing slash from a configured base URL so paths don't double up", async () => {
    // `${baseUrl}${path}` with a trailing slash would produce `//tags`, which some
    // gateways treat as a different (404) route.
    const calls = stubUrlCapture();

    await new ClosedLoopClient({
      apiKey: "k",
      projectSlug: "proj",
      baseUrl: "https://api.test/",
    }).listTags();

    expect(calls[0]).not.toContain("//tags");
  });
});

describe("ClosedLoopClient error surfacing", () => {
  it("includes the raw body in the error when a failure response is not JSON", async () => {
    // A 502 from a proxy returns HTML, not an envelope. Swallowing it would leave
    // the operator with a status code and no clue what happened.
    stubFetch("<html>gateway blew up</html>", false, 502);

    await expect(new ClosedLoopClient(CFG).listTags()).rejects.toThrow(
      GATEWAY_BODY
    );
  });

  it("names the status code on a failure response", async () => {
    stubFetch(JSON.stringify({ success: false, error: "nope" }), false, 500);

    await expect(new ClosedLoopClient(CFG).listTags()).rejects.toThrow(
      STATUS_500
    );
  });
});
