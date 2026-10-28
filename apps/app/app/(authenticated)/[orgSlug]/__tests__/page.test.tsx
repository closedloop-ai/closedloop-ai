import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import OrgRootPage from "../page";

/**
 * `/{orgSlug}` lands on Dashboard for EVERY workspace.
 *
 * This used to branch on `WorkspaceExperience`: a legacy (or unresolved)
 * workspace was forwarded to My Tasks and only an enrolled v2 workspace reached
 * Dashboard — which is why the app still opened on My Tasks long after Dashboard
 * became the canonical landing route. ISS-10195 removed the gate entirely; this
 * pins that the landing stayed unconditional rather than acquiring a new split.
 */
const DASHBOARD_HREF = "/acme/dashboard";

const redirectHrefs = vi.hoisted((): string[] => []);

vi.mock("@repo/app/shared/components/client-redirect", () => ({
  ClientRedirect: ({ href }: { href: string }) => {
    redirectHrefs.push(href);
    return <div data-href={href} data-testid="client-redirect" />;
  },
}));

vi.mock("@/hooks/use-org-slug", () => ({
  useOrgSlug: () => "acme",
}));

afterEach(() => {
  redirectHrefs.length = 0;
  cleanup();
});

describe("org root shell entry", () => {
  it("lands every workspace on Dashboard", () => {
    render(<OrgRootPage />);

    expect(screen.getByTestId("client-redirect")).toHaveAttribute(
      "data-href",
      DASHBOARD_HREF
    );
    expect(redirectHrefs).toEqual([DASHBOARD_HREF]);
  });
});
