import {
  GITHUB_CLERK_LINK_PATH,
  GITHUB_RESUME_INSTALLATION_ID_PARAM,
} from "@repo/api/src/types/github-clerk-link";
import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

/**
 * PLN-1742 M3/M5 server entry. Every branch here is query-string parsing and
 * a resume-path string build — no client-runtime concerns — so the render
 * only has to prove which values reach `ClerkGitHubLinkClient`.
 */

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  auth: mocks.auth,
}));

const clientProps = vi.hoisted(
  () => ({ last: null }) as { last: Record<string, unknown> | null }
);
vi.mock("../clerk-github-link-client", () => ({
  ClerkGitHubLinkClient: (props: Record<string, unknown>) => {
    clientProps.last = props;
    return <div data-testid="clerk-github-link-client" />;
  },
}));

import ClerkGitHubLinkPage from "../page";

const ORG_SLUG = "acme";
/** Not exported by the page — the fallback this test pins by literal value. */
const DEFAULT_RETURN_PATH = "/settings";

async function renderPage(
  searchParams: Record<string, string | string[] | undefined>
): Promise<void> {
  render(
    await ClerkGitHubLinkPage({ searchParams: Promise.resolve(searchParams) })
  );
}

beforeEach(() => {
  clientProps.last = null;
  mocks.auth.mockReset();
  mocks.auth.mockResolvedValue({ orgSlug: ORG_SLUG });
});

describe("ClerkGitHubLinkPage — returnTo", () => {
  it("falls back to the default return path and an un-suffixed resume path with no returnTo", async () => {
    mocks.auth.mockResolvedValue({ orgSlug: null });

    await renderPage({});

    expect(screen.getByTestId("clerk-github-link-client")).toBeDefined();
    expect(clientProps.last?.returnToPath).toBe(DEFAULT_RETURN_PATH);
    expect(clientProps.last?.resumePath).toBe(GITHUB_CLERK_LINK_PATH);
  });

  it("canonicalizes a valid returnTo and carries it, raw, on the resume path", async () => {
    await renderPage({ returnTo: "/settings" });

    expect(clientProps.last?.returnToPath).toBe(`/${ORG_SLUG}/settings`);
    expect(clientProps.last?.resumePath).toBe(
      `${GITHUB_CLERK_LINK_PATH}?returnTo=${encodeURIComponent("/settings")}`
    );
  });

  it("falls back to the default return path when returnTo does not validate, but still preserves it on the resume path", async () => {
    // `?` makes this an invalid same-origin path per getCompatibleGitHubReturnPath.
    const invalidReturnTo = "/settings?x=1";

    await renderPage({ returnTo: invalidReturnTo });

    expect(clientProps.last?.returnToPath).toBe(DEFAULT_RETURN_PATH);
    // The RAW value still rides the resume path — signing in must resume the
    // connect with the original query intact, even though it did not validate
    // as a post-link destination.
    expect(clientProps.last?.resumePath).toBe(
      `${GITHUB_CLERK_LINK_PATH}?returnTo=${encodeURIComponent(invalidReturnTo)}`
    );
  });

  it("ignores a non-string returnTo (repeated query param) the same as an absent one", async () => {
    await renderPage({ returnTo: ["/settings", "/branches"] });

    expect(clientProps.last?.returnToPath).toBe(DEFAULT_RETURN_PATH);
    expect(clientProps.last?.resumePath).toBe(GITHUB_CLERK_LINK_PATH);
  });
});

describe("ClerkGitHubLinkPage — resumeInstallationId", () => {
  it("resumes a numeric installation id from the install callback", async () => {
    await renderPage({
      [GITHUB_RESUME_INSTALLATION_ID_PARAM]: "42",
    });

    expect(clientProps.last?.resumeInstallationId).toBe("42");
  });

  it("drops a non-numeric installation id rather than resuming a bogus claim", async () => {
    await renderPage({
      [GITHUB_RESUME_INSTALLATION_ID_PARAM]: "not-a-number",
    });

    expect(clientProps.last?.resumeInstallationId).toBeNull();
  });

  it("drops a non-string installation id (repeated query param)", async () => {
    await renderPage({
      [GITHUB_RESUME_INSTALLATION_ID_PARAM]: ["42", "43"],
    });

    expect(clientProps.last?.resumeInstallationId).toBeNull();
  });

  it("is absent (null) when the install callback handed nothing over", async () => {
    await renderPage({});

    expect(clientProps.last?.resumeInstallationId).toBeNull();
  });
});
