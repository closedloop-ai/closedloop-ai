import { PINNED_FEATURE_FLAGS_ROUTE_PATH } from "@repo/api/src/types/feature-flag-snapshot";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getToken: vi.fn(),
  fetch: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/auth/server", () => ({
  auth: () => Promise.resolve({ getToken: mocks.getToken }),
}));
vi.mock("@/lib/api-origin", () => ({
  resolveApiOrigin: () => "https://api.test",
}));

import { resolvePinnedFeatureFlags } from "@/lib/analytics/pinned-feature-flags";

const FLAGS = { "session-trace-tab": true, "pensero-integration": "variant-a" };

beforeEach(() => {
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getToken.mockResolvedValue("clerk-token");
  mocks.fetch.mockResolvedValue(
    Response.json({
      success: true,
      data: {
        snapshot: { takenAt: "2026-10-06T15:00:00.000Z", flags: FLAGS },
      },
    })
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

/**
 * ISS-12048: the web shell pins the browser's flags to a `$vibe` preview's
 * snapshot. Only a Vercel preview render asks; production and stage never do.
 */
describe("resolvePinnedFeatureFlags", () => {
  it("never asks outside a preview deployment", async () => {
    await expect(resolvePinnedFeatureFlags("production")).resolves.toBeNull();
    await expect(resolvePinnedFeatureFlags(undefined)).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });

  it("reads the API's pinned flags with the signed-in user's token in a preview", async () => {
    await expect(resolvePinnedFeatureFlags("preview")).resolves.toEqual(FLAGS);
    expect(mocks.fetch).toHaveBeenCalledWith(
      `https://api.test${PINNED_FEATURE_FLAGS_ROUTE_PATH}`,
      expect.objectContaining({
        headers: { Authorization: "Bearer clerk-token" },
      })
    );
  });

  it("pins nothing when the API has no snapshot, is unreachable, or answers garbage", async () => {
    mocks.fetch.mockResolvedValueOnce(
      Response.json({ success: true, data: { snapshot: null } })
    );
    await expect(resolvePinnedFeatureFlags("preview")).resolves.toBeNull();

    mocks.fetch.mockRejectedValueOnce(new Error("network"));
    await expect(resolvePinnedFeatureFlags("preview")).resolves.toBeNull();

    mocks.fetch.mockResolvedValueOnce(new Response('{"nope":1}'));
    await expect(resolvePinnedFeatureFlags("preview")).resolves.toBeNull();
  });

  it("pins nothing for a signed-out render", async () => {
    mocks.getToken.mockResolvedValue(null);

    await expect(resolvePinnedFeatureFlags("preview")).resolves.toBeNull();
    expect(mocks.fetch).not.toHaveBeenCalled();
  });
});
