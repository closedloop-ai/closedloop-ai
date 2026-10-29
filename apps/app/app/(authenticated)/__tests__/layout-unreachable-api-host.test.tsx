/**
 * ISS-9797: on a per-deployment preview address the app derives an API host no
 * deployment owns, so every client-side read is CORS-blocked — and the shell
 * rendered anyway, claiming `Teams unavailable` and `— Unavailable` about data
 * it never reached. The operator's 2026-09-12 ruling kept the rewrite and asked
 * the app to say what the address is instead.
 *
 * These tests drive the real layout: the honest screen replaces the shell on a
 * deployment-hash host, and nothing changes on any other host.
 */

import { render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const HASH_PREVIEW_HOST = "app-stage-dx28itjr4.preview.stage.example";
const BRANCH_PREVIEW_HOST = "app-stage-git-main.preview.stage.example";
const STABLE_HOST = "app.stage.example";
const STABLE_APP_URL = `https://${STABLE_HOST}`;
const UNREACHABLE_TITLE = "This preview link can't reach the API";

const { authMock, redirectToSignUpMock, headersMock, mockEnv } = vi.hoisted(
  () => ({
    authMock: vi.fn(),
    redirectToSignUpMock: vi.fn(() => "SIGN_UP_REDIRECT"),
    headersMock: vi.fn(),
    mockEnv: {
      NEXT_PUBLIC_API_URL: "https://api.stage.example",
      NEXT_PUBLIC_APP_URL: "https://app.stage.example",
    },
  })
);

vi.mock("@repo/auth/server", () => ({ auth: authMock }));

vi.mock("next/headers", () => ({
  cookies: vi.fn(async () => ({ get: () => undefined })),
  headers: headersMock,
}));

vi.mock("@/env", () => ({ env: mockEnv }));

// The shell's provider tree is not what these tests are about; stub it so the
// layout imports cheaply. `GlobalSidebar` renders its children so the
// pass-through case can assert that the app content actually mounted.
vi.mock("@repo/analytics/components/user-identifier", () => ({
  UserIdentifier: () => null,
}));
vi.mock("@repo/app/shared/components/mobile-bottom-nav", () => ({
  MobileBottomNav: () => null,
}));
vi.mock("@repo/app/undo/components/undo-keybinding-layer", () => ({
  UndoKeybindingLayer: () => null,
}));
vi.mock("@repo/app/undo/hooks/use-undo-stack", () => ({
  UndoStackProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@repo/design-system/components/ui/sidebar", () => ({
  SIDEBAR_COOKIE_NAME: "sidebar",
  SidebarProvider: ({ children }: { children: unknown }) => children,
}));
vi.mock("@/lib/frontend-capture/frontend-capture-controller", () => ({
  FrontendCaptureController: () => null,
}));
vi.mock(
  "@repo/app/documents/components/collaboration-provider-wrapper",
  () => ({
    CollaborationProviderWrapper: ({ children }: { children: unknown }) =>
      children,
  })
);
vi.mock("../components/artifact-route-prewarm", () => ({
  ArtifactRoutePrewarm: () => null,
}));
vi.mock("../components/command-palette", () => ({
  CommandPalette: () => null,
}));
vi.mock("../components/onboarding-guard", () => ({
  OnboardingGuard: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/sidebar", () => ({
  GlobalSidebar: ({ children }: { children: unknown }) => children,
}));
vi.mock("../components/workspace-auth-guard", () => ({
  WorkspaceAuthGuard: ({ children }: { children: unknown }) => children,
}));

function stubHost(host: string) {
  headersMock.mockResolvedValue(new Map([["host", host]]));
}

/** A request whose `Host` and `x-forwarded-host` disagree (whitlockk PR review). */
function stubConflictingHosts(host: string, forwardedHost: string) {
  headersMock.mockResolvedValue(
    new Map([
      ["host", host],
      ["x-forwarded-host", forwardedHost],
    ])
  );
}

function stubSession(userId: string | null) {
  authMock.mockResolvedValue({
    redirectToSignUp: redirectToSignUpMock,
    redirectToSignIn: vi.fn(),
    userId,
  });
}

async function renderLayout(children: React.ReactNode) {
  const AppLayout = (await import("../layout")).default;
  return await AppLayout({ children });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.NEXT_PUBLIC_APP_URL = STABLE_APP_URL;
});

describe("(authenticated) layout on an unreachable preview address", () => {
  it("replaces the shell with the honest screen instead of rendering app content", async () => {
    stubSession("user_1");
    stubHost(HASH_PREVIEW_HOST);

    render(await renderLayout(<div>workspace content</div>));

    // The screen IS the page here, so its title is the document's only heading.
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: UNREACHABLE_TITLE,
      })
    ).toBeInTheDocument();
    // Positive sibling for the negative below: the explanation names the
    // address the reader typed, so the copy is about this link and not a guess
    // about why data is missing.
    expect(screen.getByText(new RegExp(HASH_PREVIEW_HOST))).toBeInTheDocument();
    // The shell — and every `Unavailable` claim it renders — is gone, not
    // merely covered.
    expect(screen.queryByText("workspace content")).not.toBeInTheDocument();
    // The shell also owns this document's `main` landmark, and it is not here
    // to provide one, so this screen must: a document with no landmark at all
    // is what removing the chrome would otherwise cost (ISS-4673).
    expect(screen.getByRole("main")).toBeInTheDocument();
  });

  it("offers the stable address as the way out", async () => {
    stubSession("user_1");
    stubHost(HASH_PREVIEW_HOST);

    render(await renderLayout(null));

    expect(
      screen.getByRole("link", { name: `Open ${STABLE_HOST}` })
    ).toHaveAttribute("href", STABLE_APP_URL);
  });

  it("answers a signed-out visitor too, rather than sending them through sign-up first", async () => {
    stubSession(null);
    stubHost(HASH_PREVIEW_HOST);

    render(await renderLayout(null));

    expect(redirectToSignUpMock).not.toHaveBeenCalled();
    expect(
      screen.getByRole("heading", {
        level: 1,
        name: UNREACHABLE_TITLE,
      })
    ).toBeInTheDocument();
  });

  it("renders the normal shell on the stable git-branch preview alias", async () => {
    stubSession("user_1");
    stubHost(BRANCH_PREVIEW_HOST);

    render(await renderLayout(<div>workspace content</div>));

    expect(screen.getByText("workspace content")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: UNREACHABLE_TITLE,
      })
    ).not.toBeInTheDocument();
  });

  it("still redirects a signed-out visitor to sign-up on a reachable host", async () => {
    stubSession(null);
    stubHost(BRANCH_PREVIEW_HOST);

    expect(await renderLayout(null)).toBe("SIGN_UP_REDIRECT");
    expect(redirectToSignUpMock).toHaveBeenCalledTimes(1);
  });

  it("reads the Host header, not a conflicting x-forwarded-host", async () => {
    // whitlockk PR review: the address the browser is on is what decides whether
    // `resolveApiOrigin` can reach an API, and a forwarded host is a claim made
    // by whatever hop set it. Trusting it would hand this screen — ahead of the
    // sign-up redirect, so to anyone — to a request on the stable address.
    stubSession("user_1");
    stubConflictingHosts(STABLE_HOST, HASH_PREVIEW_HOST);

    render(await renderLayout(<div>workspace content</div>));

    expect(screen.getByText("workspace content")).toBeInTheDocument();
    expect(
      screen.queryByRole("heading", {
        level: 1,
        name: UNREACHABLE_TITLE,
      })
    ).not.toBeInTheDocument();
  });

  it("offers no way out when the configured URL is the dead address itself", async () => {
    // davetho PR review: the request carries the default port and the parsed
    // `NEXT_PUBLIC_APP_URL` host drops it, so an un-normalized compare reads one
    // address as two and offers a button that reloads this very screen.
    stubSession("user_1");
    stubHost(`${HASH_PREVIEW_HOST}:443`);
    mockEnv.NEXT_PUBLIC_APP_URL = `https://${HASH_PREVIEW_HOST}`;

    render(await renderLayout(null));

    expect(
      screen.getByRole("heading", { level: 1, name: UNREACHABLE_TITLE })
    ).toBeInTheDocument();
    expect(screen.queryByRole("link")).not.toBeInTheDocument();
  });
});
