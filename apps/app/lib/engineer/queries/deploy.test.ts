import { afterEach, describe, expect, it, vi } from "vitest";
import { deployHealthOptions } from "@/lib/engineer/queries/deploy";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  vi.restoreAllMocks();
});

describe("deployHealthOptions", () => {
  it("returns policy-denied alive:false responses without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(
          JSON.stringify({
            alive: false,
            statusCode: null,
            error: "url blocked by desktop outbound policy",
            code: "OUTBOUND_URL_DENIED",
          }),
          { status: 200 }
        )
      )
    );

    const options = deployHealthOptions("TICKET-1", "https://example.com");
    if (!options.queryFn) {
      throw new Error("deployHealthOptions queryFn missing");
    }
    const result = await options.queryFn({} as never);

    expect(result).toMatchObject({
      alive: false,
      statusCode: null,
      code: "OUTBOUND_URL_DENIED",
    });
  });

  it("still throws when the gateway route returns non-OK transport status", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(new Response("blocked", { status: 500 }))
    );

    const options = deployHealthOptions("TICKET-1", "https://example.com");
    if (!options.queryFn) {
      throw new Error("deployHealthOptions queryFn missing");
    }

    await expect(options.queryFn({} as never)).rejects.toThrow(
      "Failed to health check"
    );
  });
});
