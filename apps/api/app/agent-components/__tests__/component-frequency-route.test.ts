import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  read: vi.fn(),
  authOptions: [] as unknown[],
}));
vi.mock("@/lib/auth/with-any-auth", () => ({
  withAnyAuth: (
    handler: (...args: unknown[]) => Promise<Response>,
    options: unknown
  ) => {
    mocks.authOptions.push(options);
    return (
      request: NextRequest,
      context: { params: Promise<{ slug: string }> }
    ) =>
      handler({ user: { organizationId: "org-a" } }, request, context.params);
  },
}));
vi.mock("../service/component-frequency", () => ({
  readComponentFrequency: mocks.read,
}));

import { GET } from "../[slug]/frequency/route";

beforeEach(() => {
  vi.clearAllMocks();
  mocks.read.mockResolvedValue({ windowDays: 30, points: [] });
});
function call(query = "", slug = "subagent::design-critic") {
  return GET(
    new NextRequest(
      `https://api.example.test/agent-components/x/frequency${query}`
    ),
    { params: Promise.resolve({ slug }) }
  );
}

describe("component frequency HTTP boundary", () => {
  it("requires read scope and forwards the authenticated organization", async () => {
    const response = await call();
    expect(response.status).toBe(200);
    expect(mocks.authOptions).toContainEqual({ requiredScopes: ["read"] });
    expect(mocks.read).toHaveBeenCalledWith(
      "org-a",
      "subagent::design-critic",
      30
    );
    await expect(response.json()).resolves.toMatchObject({
      data: { windowDays: 30, points: [] },
    });
  });

  it.each(["0", "366", "1.5", "", "unknown"])(
    "refuses an invalid aggregate window before reading: %s",
    async (windowDays) => {
      const response = await call(`?windowDays=${windowDays}`);
      expect(response.status).toBe(400);
      expect(mocks.read).not.toHaveBeenCalled();
    }
  );

  it("refuses malformed identity without reading another component", async () => {
    const response = await call("", "not-a-component-route");
    expect(response.status).toBe(404);
    expect(mocks.read).not.toHaveBeenCalled();
  });
});
