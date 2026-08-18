import { afterEach, describe, expect, it, vi } from "vitest";
import { boundedFetch } from "../bounded-fetch";
import { getUserTokenOctokit } from "../user-token-auth";

describe("getUserTokenOctokit", () => {
  it("authenticates requests with the user token through the injected fetch", async () => {
    const seenAuthHeaders: (string | null)[] = [];
    const fetchMock = vi.fn(
      (_url: Parameters<typeof fetch>[0], init?: RequestInit) => {
        seenAuthHeaders.push(new Headers(init?.headers).get("authorization"));
        return Promise.resolve(
          new Response(JSON.stringify({ id: 1 }), {
            status: 200,
            headers: { "content-type": "application/json" },
          })
        );
      }
    );

    const octokit = getUserTokenOctokit("user-token-1", { fetch: fetchMock });
    await octokit.rest.repos.get({ owner: "acme", repo: "widgets" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(seenAuthHeaders).toEqual(["token user-token-1"]);
  });

  describe("boundedFetch (the default transport)", () => {
    afterEach(() => {
      vi.unstubAllGlobals();
    });

    it("attaches a timeout abort signal to every request", async () => {
      const seenSignals: unknown[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init?: RequestInit) => {
          seenSignals.push(init?.signal);
          return Promise.resolve(new Response("{}", { status: 200 }));
        })
      );

      await boundedFetch("https://api.github.test/anything");

      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]).toBeInstanceOf(AbortSignal);
    });

    it("composes the timeout with a caller-supplied signal", async () => {
      const seenSignals: AbortSignal[] = [];
      vi.stubGlobal(
        "fetch",
        vi.fn((_url: unknown, init?: RequestInit) => {
          if (init?.signal) {
            seenSignals.push(init.signal);
          }
          return Promise.resolve(new Response("{}", { status: 200 }));
        })
      );
      const callerController = new AbortController();

      await boundedFetch("https://api.github.test/anything", {
        signal: callerController.signal,
      });
      callerController.abort();

      expect(seenSignals).toHaveLength(1);
      expect(seenSignals[0]?.aborted).toBe(true);
    });
  });
});
