// @vitest-environment node
/**
 * ISS-11929: a server-side capture made inside `withPostHogRequestContext`
 * carries the browser's `$session_id` only when `X-POSTHOG-SESSION-ID` is a
 * real posthog-js session id. Driven through a REAL posthog-node client, so the
 * assertion is on the event posthog-node builds, not on a mock's arguments.
 */
import type { PostHog } from "posthog-node";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// What posthog-js `uuidv7()` mints for a session.
const BROWSER_SESSION_ID = "019a0f3e-8c2b-7a4d-9e1f-0123456789ab";

vi.mock("./keys", () => ({
  keys: () => ({
    NEXT_PUBLIC_POSTHOG_KEY: "phc_request_context_test",
    NEXT_PUBLIC_POSTHOG_HOST: "https://posthog.test",
  }),
}));

let client: PostHog | undefined;

beforeEach(() => {
  vi.stubGlobal(
    "fetch",
    vi.fn(() => Promise.resolve(new Response("{}", { status: 200 })))
  );
});

afterEach(async () => {
  await client?.shutdown();
  client = undefined;
  vi.unstubAllGlobals();
});

describe("withPostHogRequestContext", () => {
  it("puts the browser's session id on a capture made inside it", async () => {
    const properties = await captureWithHeaders({
      "X-POSTHOG-SESSION-ID": BROWSER_SESSION_ID,
    });

    expect(properties.$session_id).toBe(BROWSER_SESSION_ID);
  });

  it("captures with no $session_id when the header is missing", async () => {
    const properties = await captureWithHeaders({});

    expect(properties).not.toHaveProperty("$session_id");
    expect(properties.surface).toBe("test");
  });

  it.each([
    ["not a uuid", "<script>"],
    [
      "a UUIDv4, which posthog-js never mints for a session",
      "5f1c2d3e-4b5a-4c6d-8e7f-0123456789ab",
    ],
  ])("captures with no $session_id when the header is %s", async (_, value) => {
    const properties = await captureWithHeaders({
      "X-POSTHOG-SESSION-ID": value,
    });

    expect(properties).not.toHaveProperty("$session_id");
    expect(properties.surface).toBe("test");
  });
});

async function captureWithHeaders(
  headers: Record<string, string>
): Promise<Record<string, unknown>> {
  vi.resetModules();
  const { nodeAnalytics, withPostHogRequestContext } = await import("./node");
  client = nodeAnalytics;

  const captured = new Promise<Record<string, unknown>>((resolve) => {
    nodeAnalytics.on(
      "capture",
      (message: { properties: Record<string, unknown> }) =>
        resolve(message.properties)
    );
  });
  withPostHogRequestContext(new Headers(headers), () =>
    nodeAnalytics.capture({
      distinctId: "user-1",
      event: "request_context_test",
      properties: { surface: "test" },
    })
  );
  return captured;
}
