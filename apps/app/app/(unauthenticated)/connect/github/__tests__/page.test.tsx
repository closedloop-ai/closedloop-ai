import {
  DesktopSignInFraming,
  DesktopSignInProvider,
  encodeDesktopEmailHint,
} from "@repo/api/src/types/desktop-authorize-url";
import { CLERK_SESSION_TASK_CHOOSE_ORGANIZATION } from "@repo/api/src/types/desktop-bootstrap";
import { render, screen, waitFor } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { DesktopBootstrapBrowserRun } from "@/lib/desktop-bootstrap-run";
import ConnectGitHubPage from "../page";

const bootstrap = vi.hoisted(() => ({
  run: null as DesktopBootstrapBrowserRun | null,
  task: null as string | null,
  mutate: vi.fn(),
  reset: vi.fn(),
}));
vi.mock("@/lib/desktop-bootstrap-run", () => ({
  resolveDesktopBootstrapBrowserRun: async () => bootstrap.run,
}));
vi.mock("@repo/auth/client", () => ({
  useSession: () => ({
    isLoaded: true,
    session: bootstrap.task ? { currentTask: { key: bootstrap.task } } : null,
  }),
}));
vi.mock("@repo/app/onboarding/hooks/use-desktop-bootstrap-authorize", () => ({
  useDesktopBootstrapAuthorize: () => ({
    mutate: bootstrap.mutate,
    reset: bootstrap.reset,
    isError: false,
  }),
}));

vi.mock("@/env", () => ({
  env: { NEXT_PUBLIC_APP_URL: "https://app.closedloop.ai" },
}));

// Both leaves are mocked to markers; the REAL page + resolvers decide which one
// mounts and with what props — that decision is the contract under test.
const signUpProps = vi.hoisted(
  () => ({ last: null }) as { last: Record<string, unknown> | null }
);
vi.mock("@repo/auth/components/sign-up", () => ({
  SignUp: (props: Record<string, unknown>) => {
    signUpProps.last = props;
    return <div data-testid="email-sign-up-embed" />;
  },
}));
const signInProps = vi.hoisted(
  () => ({ last: null }) as { last: Record<string, unknown> | null }
);
vi.mock("@repo/auth/components/sign-in", () => ({
  SignIn: (props: Record<string, unknown>) => {
    signInProps.last = props;
    return <div data-testid="email-sign-in-embed" />;
  },
}));
const clientProps = vi.hoisted(
  () => ({ last: null }) as { last: Record<string, unknown> | null }
);
vi.mock("../github-connect-redirect-client", () => ({
  GitHubConnectRedirectClient: (props: Record<string, unknown>) => {
    clientProps.last = props;
    return <div data-testid="sso-redirect-client" />;
  },
}));

const TARGET = "/settings/integrations/desktop/authorize?state=xyz";
const TARGET_URL = `https://app.closedloop.ai${TARGET}`;

async function renderPage(
  searchParams: Record<string, string | string[] | undefined>
): Promise<void> {
  render(
    await ConnectGitHubPage({ searchParams: Promise.resolve(searchParams) })
  );
}

beforeEach(() => {
  bootstrap.run = null;
  bootstrap.task = null;
  bootstrap.mutate.mockClear();
  signUpProps.last = null;
  signInProps.last = null;
  clientProps.last = null;
});

describe("ConnectGitHubPage — method branch (ISS-5954 M3)", () => {
  it("unmounts the signup embed as soon as the Desktop organization task appears", async () => {
    bootstrap.run = {
      bootstrapSupported: true,
      codeChallenge: "challenge",
      codeChallengeMethod: "S256",
      gatewayId: "gateway",
      gatewayPublicKeyPem: "public-key",
      redirectUri: "http://127.0.0.1:49517/cb",
      state: "state",
    };
    const page = await ConnectGitHubPage({
      searchParams: Promise.resolve({
        provider: "email",
        redirect_url: TARGET_URL,
      }),
    });
    const view = render(page);
    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(bootstrap.mutate).not.toHaveBeenCalled();

    bootstrap.task = CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;
    view.rerender(
      await ConnectGitHubPage({
        searchParams: Promise.resolve({
          provider: "email",
          redirect_url: TARGET_URL,
        }),
      })
    );
    expect(screen.queryByTestId("email-sign-up-embed")).toBeNull();
    await waitFor(() => expect(bootstrap.mutate).toHaveBeenCalledTimes(1));
  });

  it("preserves the signup embed for an organization task without a Desktop run", async () => {
    bootstrap.task = CLERK_SESSION_TASK_CHOOSE_ORGANIZATION;
    await renderPage({ provider: "email", redirect_url: TARGET_URL });
    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(bootstrap.mutate).not.toHaveBeenCalled();
  });
  it("lands an email pick on the Clerk embed — never the SSO auto-fire", async () => {
    await renderPage({ provider: "email", redirect_url: TARGET_URL });

    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(screen.queryByTestId("sso-redirect-client")).toBeNull();
    // The validated target rides BOTH directions of the embed, so sign-up and
    // the cross-linked sign-in both return to the desktop authorize page.
    expect(signUpProps.last?.forceRedirectUrl).toBe(TARGET);
    expect(signUpProps.last?.signInForceRedirectUrl).toBe(TARGET);
    expect(signUpProps.last?.routing).toBe("hash");
  });

  // ISS-5954 M5: the decoded address reaches nothing but the form's initial
  // value.
  it("prefills the email form from a valid hint", async () => {
    const hint = encodeDesktopEmailHint("kerensa+desktop@closedloop.ai");
    await renderPage({
      provider: "email",
      email_hint: hint ?? undefined,
      redirect_url: TARGET_URL,
    });
    expect(signUpProps.last?.initialValues).toEqual({
      emailAddress: "kerensa+desktop@closedloop.ai",
    });
  });

  it("drops a hint that does not decode to a plausible address", async () => {
    await renderPage({
      provider: "email",
      email_hint: "garbage",
      redirect_url: TARGET_URL,
    });
    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(signUpProps.last?.initialValues).toBeUndefined();
  });

  it("keeps the email branch behind the open-redirect boundary", async () => {
    await renderPage({
      provider: "email",
      redirect_url: "https://evil.test/steal",
    });

    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(signUpProps.last?.forceRedirectUrl).toBe("/");
    expect(signUpProps.last?.signInForceRedirectUrl).toBe("/");
  });

  it("starts the SSO redirect for a social pick", async () => {
    await renderPage({ provider: "google", redirect_url: TARGET_URL });

    expect(screen.getByTestId("sso-redirect-client")).toBeDefined();
    expect(screen.queryByTestId("email-sign-up-embed")).toBeNull();
    expect(clientProps.last?.provider).toBe(DesktopSignInProvider.Google);
    expect(clientProps.last?.redirectUrlComplete).toBe(TARGET);
  });

  it("defaults an absent hint to the GitHub SSO flow — the version-skew contract", async () => {
    await renderPage({ redirect_url: TARGET_URL });

    expect(screen.getByTestId("sso-redirect-client")).toBeDefined();
    expect(clientProps.last?.provider).toBe(DesktopSignInProvider.GitHub);
  });

  it("defaults an unrecognized hint to the GitHub SSO flow, never the email form", async () => {
    await renderPage({ provider: "gitlab", redirect_url: TARGET_URL });

    expect(screen.getByTestId("sso-redirect-client")).toBeDefined();
    expect(screen.queryByTestId("email-sign-up-embed")).toBeNull();
    expect(clientProps.last?.provider).toBe(DesktopSignInProvider.GitHub);
  });

  // ISS-5954 — a returning-user door declares the sign-in framing; answering
  // it with an account-creation form is the wrong-door class this route
  // exists to close.
  it("renders the sign-IN embed for an email pick framed as sign-in", async () => {
    const hint = encodeDesktopEmailHint("kerensa+desktop@closedloop.ai");
    await renderPage({
      provider: "email",
      framing: DesktopSignInFraming.SignIn,
      email_hint: hint ?? undefined,
      redirect_url: TARGET_URL,
    });

    expect(screen.getByTestId("email-sign-in-embed")).toBeDefined();
    expect(screen.queryByTestId("email-sign-up-embed")).toBeNull();
    expect(screen.queryByTestId("sso-redirect-client")).toBeNull();
    // The validated target rides BOTH directions of this embed too.
    expect(signInProps.last?.forceRedirectUrl).toBe(TARGET);
    expect(signInProps.last?.signUpForceRedirectUrl).toBe(TARGET);
    expect(signInProps.last?.routing).toBe("hash");
    expect(signInProps.last?.initialValues).toEqual({
      emailAddress: "kerensa+desktop@closedloop.ai",
    });
  });

  it("defaults an unrecognized framing to the sign-up embed", async () => {
    await renderPage({
      provider: "email",
      framing: "sideways",
      redirect_url: TARGET_URL,
    });

    expect(screen.getByTestId("email-sign-up-embed")).toBeDefined();
    expect(screen.queryByTestId("email-sign-in-embed")).toBeNull();
  });

  it("keeps the sign-in framed email branch behind the open-redirect boundary", async () => {
    await renderPage({
      provider: "email",
      framing: DesktopSignInFraming.SignIn,
      redirect_url: "https://evil.test/steal",
    });

    expect(screen.getByTestId("email-sign-in-embed")).toBeDefined();
    expect(signInProps.last?.forceRedirectUrl).toBe("/");
    expect(signInProps.last?.signUpForceRedirectUrl).toBe("/");
  });

  it("ignores the framing on a social pick — it decorates the email branch only", async () => {
    await renderPage({
      provider: "github",
      framing: DesktopSignInFraming.SignIn,
      redirect_url: TARGET_URL,
    });

    expect(screen.getByTestId("sso-redirect-client")).toBeDefined();
    expect(screen.queryByTestId("email-sign-in-embed")).toBeNull();
  });
});
