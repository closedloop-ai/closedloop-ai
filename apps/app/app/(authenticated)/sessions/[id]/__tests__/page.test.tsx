import { beforeEach, describe, expect, it, vi } from "vitest";

// FEA-4155: the legacy non-org `/sessions/[id]` detail (still `<FeatureFlagged>`
// on the winding-down `DESKTOP_AGENT_SESSION_SYNC` flag) was collapsed into a
// server-side redirect to the canonical `/{orgSlug}/sessions/[id]` route,
// preserving the query string so transcript-file / invocation-anchor deep links
// survive. This suite proves the redirect target, not the old rendered detail.

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

import LegacySessionDetailRedirect from "../page";

const ORG_SLUG = "acme";
const SESSION_ID = "session-detail-1";

function invoke(
  searchParams: Record<string, string | string[] | undefined> = {}
) {
  return LegacySessionDetailRedirect({
    params: Promise.resolve({ id: SESSION_ID }),
    searchParams: Promise.resolve(searchParams),
  });
}

describe("legacy /sessions/[id] redirect (FEA-4155)", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("redirects to the org detail route for a valid org slug", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: ORG_SLUG });

    await invoke();

    expect(mocks.redirect).toHaveBeenCalledWith(
      `/${ORG_SLUG}/sessions/${SESSION_ID}`
    );
  });

  it("preserves the query string (transcript file / invocation anchor deep links)", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: ORG_SLUG });

    await invoke({ file: "subagent-2", invocationAnchor: '{"kind":"event"}' });

    const target = mocks.redirect.mock.calls[0]?.[0] as string;
    expect(target.startsWith(`/${ORG_SLUG}/sessions/${SESSION_ID}?`)).toBe(
      true
    );
    expect(target).toContain("file=subagent-2");
    expect(target).toContain(
      `invocationAnchor=${encodeURIComponent('{"kind":"event"}')}`
    );
  });

  it("falls back to the non-org detail path when no org slug is present", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: null });

    await invoke();

    expect(mocks.redirect).toHaveBeenCalledWith(`/sessions/${SESSION_ID}`);
  });
});
