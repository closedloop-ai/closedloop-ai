import { beforeEach, describe, expect, it, vi } from "vitest";

// FEA-4155: the legacy non-org `/sessions` list page was collapsed into a
// server-side redirect to the canonical `/{orgSlug}/sessions` route (bot review
// #3789), matching the legacy-monitoring redirect. This suite proves the
// redirect target, not the old rendered layout (which is gone).

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  redirect: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  auth: mocks.auth,
}));

vi.mock("next/navigation", () => ({
  redirect: mocks.redirect,
}));

import LegacySessionsRedirect from "../page";

const ORG_SLUG = "acme";

describe("legacy /sessions redirect (FEA-4155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to the org Sessions route when the session carries a valid org slug", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: ORG_SLUG });

    await LegacySessionsRedirect();

    expect(mocks.redirect).toHaveBeenCalledWith(`/${ORG_SLUG}/sessions`);
  });

  it("falls back to the app root when no org slug is present", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: null });

    await LegacySessionsRedirect();

    expect(mocks.redirect).toHaveBeenCalledWith("/");
  });

  it("falls back to the app root when the org slug is malformed", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: "Not A Valid Slug!" });

    await LegacySessionsRedirect();

    expect(mocks.redirect).toHaveBeenCalledWith("/");
  });
});
