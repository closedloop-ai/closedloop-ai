import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { fetchRepoPath, repoPathOptions } from "../repo-path";

const originalFetch = globalThis.fetch;

beforeEach(() => {
  vi.restoreAllMocks();
});

afterEach(() => {
  globalThis.fetch = originalFetch;
});

describe("fetchRepoPath", () => {
  test("returns resolved path when endpoint responds with valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: "/Users/alice/src/acme/web" }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: "/Users/alice/src/acme/web" });
  });

  test("returns { path: null } on 404 (endpoint missing on older Electron)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("Not Found", { status: 404 }));
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("returns { path: null } on any non-2xx status (500, 501, etc.)", async () => {
    globalThis.fetch = vi
      .fn()
      .mockResolvedValue(new Response("boom", { status: 500 }));
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("returns { path: null } when fetch itself throws (network error)", async () => {
    globalThis.fetch = vi.fn().mockRejectedValue(new TypeError("Failed"));
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("returns { path: null } when response body is not valid JSON", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response("<html>oops</html>", {
        status: 200,
        headers: { "Content-Type": "text/html" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });

  test("returns { path: null } when response is JSON but path is not a string", async () => {
    globalThis.fetch = vi.fn().mockResolvedValue(
      new Response(JSON.stringify({ path: null }), {
        status: 200,
        headers: { "Content-Type": "application/json" },
      })
    );
    const result = await fetchRepoPath("acme/web");
    expect(result).toEqual({ path: null });
  });
});

describe("repoPathOptions", () => {
  test("disables the query when repoFullName is null", () => {
    const options = repoPathOptions(null, "cloud-relay:abc");
    expect(options.enabled).toBe(false);
  });

  test("disables the query when repoFullName is empty", () => {
    const options = repoPathOptions("", "cloud-relay:abc");
    expect(options.enabled).toBe(false);
  });

  test("enables the query when repoFullName is present", () => {
    const options = repoPathOptions("acme/web", "cloud-relay:abc");
    expect(options.enabled).toBe(true);
  });

  test("disables retries so a missing endpoint is not hammered", () => {
    const options = repoPathOptions("acme/web", "cloud-relay:abc");
    expect(options.retry).toBe(false);
  });
});
