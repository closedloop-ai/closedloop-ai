import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * FEA-3983/3970: Agent Monitoring was removed (superseded by Sessions, which
 * owns the session list, its facets, and per-session detail). The old routes are
 * kept only as temporary redirects to Sessions so bookmarks and inbox/Slack deep
 * links do not 404. These tests pin the redirect target (Sessions, not the
 * Dashboard — per the PR review), the temporary (not permanent) status, that a
 * filtered link's query params are forwarded, and that a malformed org slug is
 * rejected instead of forging an open redirect.
 */

const { authMock, redirectMock, notFoundMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  // next/navigation's redirect throws internally to halt rendering; mirror that
  // so the page function stops after calling it, and the sentinel lets us assert
  // the call target from the test body.
  redirectMock: vi.fn((_target: string) => {
    throw new Error("REDIRECT");
  }),
  notFoundMock: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  notFound: notFoundMock,
}));

vi.mock("@repo/auth/server", () => ({
  auth: authMock,
}));

const emptySearchParams = Promise.resolve(
  {} as Record<string, string | string[] | undefined>
);

describe("Agent Monitoring redirect", () => {
  beforeEach(() => {
    redirectMock.mockClear();
    notFoundMock.mockClear();
    authMock.mockReset();
  });

  it("redirects the org-slugged route to the org Sessions list", async () => {
    const MonitoringRedirect = (
      await import("../[orgSlug]/loops/monitoring/page")
    ).default;

    await expect(
      MonitoringRedirect({
        params: Promise.resolve({ orgSlug: "acme" }),
        searchParams: emptySearchParams,
      })
    ).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/acme/sessions");
  });

  it("forwards filter query params (single and multi-value) to Sessions", async () => {
    const MonitoringRedirect = (
      await import("../[orgSlug]/loops/monitoring/page")
    ).default;

    await expect(
      MonitoringRedirect({
        params: Promise.resolve({ orgSlug: "acme" }),
        searchParams: Promise.resolve({
          status: ["failed", "active"],
          harness: "claude",
          // A param Sessions does not model is still forwarded harmlessly.
          teamId: "team_1",
          // An undefined value is dropped, not serialized as "undefined".
          projectId: undefined,
        }),
      })
    ).rejects.toThrow("REDIRECT");

    const target = redirectMock.mock.calls[0]?.[0] as string;
    expect(target.startsWith("/acme/sessions?")).toBe(true);
    const forwarded = new URLSearchParams(target.split("?")[1]);
    expect(forwarded.getAll("status")).toEqual(["failed", "active"]);
    expect(forwarded.get("harness")).toBe("claude");
    expect(forwarded.get("teamId")).toBe("team_1");
    expect(forwarded.has("projectId")).toBe(false);
  });

  it("404s (no open redirect) when the org slug is a malformed encoded-slash value", async () => {
    const MonitoringRedirect = (
      await import("../[orgSlug]/loops/monitoring/page")
    ).default;

    await expect(
      MonitoringRedirect({
        // Next.js decodes `%2Fevil.example` to `/evil.example`; without
        // validation this would produce `//evil.example/sessions`.
        params: Promise.resolve({ orgSlug: "/evil.example" }),
        searchParams: emptySearchParams,
      })
    ).rejects.toThrow("NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects the org-scoped session deep link to org Sessions detail", async () => {
    const SessionRedirect = (
      await import("../[orgSlug]/loops/monitoring/sessions/[id]/page")
    ).default;

    await expect(
      SessionRedirect({
        params: Promise.resolve({ orgSlug: "acme", id: "sess_123" }),
      })
    ).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/acme/sessions/sess_123");
  });

  it("404s the org-scoped session deep link on a malformed org slug", async () => {
    const SessionRedirect = (
      await import("../[orgSlug]/loops/monitoring/sessions/[id]/page")
    ).default;

    await expect(
      SessionRedirect({
        params: Promise.resolve({ orgSlug: "/evil.example", id: "sess_123" }),
      })
    ).rejects.toThrow("NOT_FOUND");

    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("redirects the legacy session deep link to the non-org Sessions detail", async () => {
    const SessionRedirect = (
      await import("../loops/monitoring/sessions/[id]/page")
    ).default;

    await expect(
      SessionRedirect({ params: Promise.resolve({ id: "sess_123" }) })
    ).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/sessions/sess_123");
  });

  it("redirects the legacy route to the session org's Sessions list", async () => {
    authMock.mockResolvedValue({ orgSlug: "acme" });
    const LegacyMonitoringRedirect = (await import("../loops/monitoring/page"))
      .default;

    await expect(LegacyMonitoringRedirect()).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/acme/sessions");
  });

  it("redirects the legacy route to the app root when no org slug resolves", async () => {
    authMock.mockResolvedValue({ orgSlug: null });
    const LegacyMonitoringRedirect = (await import("../loops/monitoring/page"))
      .default;

    await expect(LegacyMonitoringRedirect()).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/");
  });

  it("redirects the legacy route to the app root when the session org slug is malformed", async () => {
    authMock.mockResolvedValue({ orgSlug: "/evil.example" });
    const LegacyMonitoringRedirect = (await import("../loops/monitoring/page"))
      .default;

    await expect(LegacyMonitoringRedirect()).rejects.toThrow("REDIRECT");

    expect(redirectMock).toHaveBeenCalledWith("/");
  });
});
