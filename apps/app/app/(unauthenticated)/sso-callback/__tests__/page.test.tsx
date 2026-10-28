import { DesktopSignInProvider } from "@repo/api/src/types/desktop-authorize-url";
import { render } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import SsoCallbackPage from "../page";

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.closedloop.ai" },
}));

// The leaf is a marker; the REAL page + resolvers decide its props, which is
// the contract under test.
const clientProps = vi.hoisted(
  () => ({ last: null }) as { last: Record<string, unknown> | null }
);
vi.mock("../sso-callback-client", () => ({
  SsoCallbackClient: (props: Record<string, unknown>) => {
    clientProps.last = props;
    return <div data-testid="sso-callback-client" />;
  },
}));

const TARGET = "/settings/integrations/desktop/authorize?state=xyz";
const TARGET_URL = `https://app.closedloop.ai${TARGET}`;

async function renderPage(
  searchParams: Record<string, string | string[] | undefined>
): Promise<void> {
  render(
    await SsoCallbackPage({ searchParams: Promise.resolve(searchParams) })
  );
}

beforeEach(() => {
  clientProps.last = null;
});

describe("SsoCallbackPage", () => {
  it("names the provider the desktop picked, defaulting to GitHub", async () => {
    await renderPage({ provider: "google", redirect_url: TARGET_URL });
    expect(clientProps.last?.provider).toBe(DesktopSignInProvider.Google);

    await renderPage({ redirect_url: TARGET_URL });
    expect(clientProps.last?.provider).toBe(DesktopSignInProvider.GitHub);
  });

  it("forces the sign-up destination when a trusted redirect_url rode in", async () => {
    await renderPage({ provider: "github", redirect_url: TARGET_URL });

    expect(clientProps.last?.signUpRedirectUrl).toBe(TARGET);
    // The fallback pair is untouched: this page still lands a returning user
    // exactly where it always did.
    expect(clientProps.last?.fallbackRedirectUrl).toBe(TARGET);
  });

  it("forces nothing when no redirect_url rode in", async () => {
    // A resumed or version-skewed callback; forcing `/` would take a returning
    // user away from the destination Clerk's own flow is carrying.
    await renderPage({ provider: "github" });

    expect(clientProps.last?.signUpRedirectUrl).toBeUndefined();
    expect(clientProps.last?.fallbackRedirectUrl).toBe("/");
  });

  it("forces nothing for a redirect_url the open-redirect boundary rejects", async () => {
    await renderPage({
      provider: "github",
      redirect_url: "https://evil.test/steal",
    });

    expect(clientProps.last?.signUpRedirectUrl).toBeUndefined();
  });
});
