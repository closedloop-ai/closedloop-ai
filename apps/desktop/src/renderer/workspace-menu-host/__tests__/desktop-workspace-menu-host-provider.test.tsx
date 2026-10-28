import {
  DesktopSignInFraming,
  DesktopSignInMethod,
} from "@repo/api/src/types/desktop-authorize-url";
import { WorkspaceMenuProjectionStatus } from "@repo/api/src/types/workspace-menu";
import { createWrapper } from "@repo/app/shared/test-utils";
import { useWorkspaceMenuHostAdapter } from "@repo/app/shared/workspace-menu-host/provider";
import { render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import {
  publishRecordingGuestRun,
  RESUME_CREATE_ACCOUNT,
  type RecordingGuestRun,
} from "../../components/onboarding/__tests__/published-guest-run-fixture";

/**
 * The PROVIDER's wiring, not the adapter's arithmetic.
 *
 * `toDesktopWorkspaceMenuProjection` already had an Error path for "settled with
 * no identity". The provider could never reach it, because it inferred
 * settlement from `identity !== null` instead of reading `isResolved` — so a
 * lapsed session or a failed identity IPC sat on "Loading" forever. The adapter
 * test passed the whole time. This is the seam that was missing.
 */

const identityState = vi.hoisted(() => ({
  identity: null as {
    organizationName: string | null;
    email: string;
    firstName: string | null;
    lastName: string | null;
    organizationImageUrl?: string | null;
    userImageUrl?: string | null;
  } | null,
  isResolved: false,
}));
const authState = vi.hoisted(() => ({
  status: "authenticated",
  beginSignIn: vi.fn(async () => ({ ok: true })),
}));

vi.mock("../../shared-agent-sessions/desktop-auth-provider", () => ({
  useDesktopAuth: () => ({
    state: { status: authState.status, userId: "user_1" },
    signOut: () => Promise.resolve(),
    beginSignIn: authState.beginSignIn,
  }),
}));

vi.mock("../../shared-agent-sessions/use-desktop-identity", () => ({
  useDesktopIdentity: () => identityState,
}));

vi.mock("../../navigation/route-table", () => ({
  hrefForNavId: () => "/diagnostics",
  NavId: { Diagnostics: "diagnostics" },
}));

const { DesktopWorkspaceMenuHostProvider } = await import(
  "../desktop-workspace-menu-host-provider"
);

/**
 * Split in two so the adapter's hook property is called UNCONDITIONALLY, the
 * same shape the real `HostedWorkspaceMenu` uses. Calling it after a null check
 * in one component is a conditional hook.
 */
function ProjectionProbe({
  adapter,
}: {
  adapter: NonNullable<ReturnType<typeof useWorkspaceMenuHostAdapter>>;
}) {
  const projection = adapter.useWorkspaceMenuProjection({ open: false });
  return (
    <>
      <span data-testid="status">{projection.status}</span>
      <span data-testid="workspace-image">
        {projection.status === WorkspaceMenuProjectionStatus.Ready
          ? String(projection.activeWorkspace.imageUrl)
          : ""}
      </span>
      <span data-testid="actor-image">
        {projection.status === WorkspaceMenuProjectionStatus.Ready
          ? String(projection.actor.imageUrl)
          : ""}
      </span>
    </>
  );
}

function Probe() {
  const adapter = useWorkspaceMenuHostAdapter();
  return adapter ? (
    <ProjectionProbe adapter={adapter} />
  ) : (
    <span data-testid="status">no-adapter</span>
  );
}

function renderProvider() {
  render(
    <DesktopWorkspaceMenuHostProvider>
      <Probe />
    </DesktopWorkspaceMenuHostProvider>,
    { wrapper: createWrapper() }
  );
  return screen.getByTestId("status").textContent;
}

let guestRun: RecordingGuestRun | null = null;

beforeEach(() => {
  authState.beginSignIn.mockClear();
  identityState.identity = null;
  identityState.isResolved = false;
  authState.status = DesktopAuthStatus.Authenticated;
});

afterEach(() => {
  guestRun?.withdraw();
  guestRun = null;
});

/** The adapter the provider hands the menu, read straight off the context. */
function renderAdapter(): ReturnType<typeof useWorkspaceMenuHostAdapter> {
  const seen: { adapter: ReturnType<typeof useWorkspaceMenuHostAdapter> } = {
    adapter: null,
  };
  function AdapterProbe() {
    seen.adapter = useWorkspaceMenuHostAdapter();
    return null;
  }
  render(
    <DesktopWorkspaceMenuHostProvider>
      <AdapterProbe />
    </DesktopWorkspaceMenuHostProvider>,
    { wrapper: createWrapper() }
  );
  return seen.adapter;
}

/**
 * ISS-11480 (PLN-2126 Step 7): the menu's Create account row resumes the
 * published guest run at the Account step, and the menu renders that row only
 * while `requestAccount` is supplied.
 */
describe("DesktopWorkspaceMenuHostProvider requestAccount", () => {
  test("resumes the published guest run at the Account step", () => {
    authState.status = DesktopAuthStatus.SignedOut;
    guestRun = publishRecordingGuestRun();

    renderAdapter()?.requestAccount?.();

    expect(guestRun.posted).toHaveLength(1);
    expect(guestRun.posted[0]?.[0]).toBe(guestRun.snapshot);
    expect(guestRun.posted[0]?.[1]).toEqual(RESUME_CREATE_ACCOUNT);
  });

  test("supplies no account request while no guest run is published", () => {
    authState.status = DesktopAuthStatus.SignedOut;

    expect(renderAdapter()?.requestAccount).toBeUndefined();
  });
});

describe("DesktopWorkspaceMenuHostProvider", () => {
  test("an unresolved identity is Pending", () => {
    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Pending);
  });

  test("an authenticated read that resolved to nothing is an Error", () => {
    // Reading settlement off identity nullability strands this on "Loading".
    identityState.isResolved = true;

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Error);
  });

  test("a lapsed session is an Error, not a permanent Pending", () => {
    authState.status = DesktopAuthStatus.RefreshFailed;
    identityState.isResolved = true;

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Error);
  });

  test("mid-sign-in is Pending, not 'Account unavailable'", () => {
    // The provider must hand the adapter the raw auth STATUS: every one of these
    // reports as resolved-with-no-identity, so a derived boolean cannot tell
    // them from a lapsed session.
    authState.status = DesktopAuthStatus.OpeningBrowser;
    identityState.isResolved = true;

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Pending);
  });

  test("a signed-out desktop is Guest even before the identity read resolves", () => {
    authState.status = DesktopAuthStatus.SignedOut;

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Guest);
  });

  test("an older server that OMITS both image keys still renders, with no image", () => {
    // ISS-11465 version skew, at the seam that actually performs it: the `??`
    // in the provider. The adapter suite can only be handed an explicit `null`,
    // because its input type has already been normalized — ABSENT keys exist
    // only here, on the wire shape `useDesktopIdentity` returns.
    authState.status = DesktopAuthStatus.Authenticated;
    identityState.isResolved = true;
    identityState.identity = {
      organizationName: "Closedloop",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
    };

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(screen.getByTestId("workspace-image").textContent).toBe("null");
    expect(screen.getByTestId("actor-image").textContent).toBe("null");
  });

  test("a source the renderer CSP refuses is dropped to no-image, not rendered", () => {
    // ISS-11465: `User.avatarUrl` is whatever `PUT /users/:id` accepted, so it
    // is NOT guaranteed to be Clerk-hosted. `img-src` admits exactly one remote
    // origin, and a refused source paints nothing behind a mounted `<img>` —
    // no initial-letter fallback, just a hole. The org logo on the SAME render
    // is the presence half: it is admitted and must survive, so this cannot
    // pass by dropping everything.
    authState.status = DesktopAuthStatus.Authenticated;
    identityState.isResolved = true;
    identityState.identity = {
      organizationName: "Closedloop",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
      organizationImageUrl: "https://img.clerk.com/org-logo",
      userImageUrl: "https://avatars.example.com/ada.png",
    };

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Ready);
    expect(screen.getByTestId("workspace-image").textContent).toBe(
      "https://img.clerk.com/org-logo"
    );
    expect(screen.getByTestId("actor-image").textContent).toBe("null");
  });

  test("a resolved identity is Ready", () => {
    authState.status = DesktopAuthStatus.Authenticated;
    identityState.isResolved = true;
    identityState.identity = {
      organizationName: "Closedloop",
      email: "ada@closedloop.ai",
      firstName: "Ada",
      lastName: "Lovelace",
    };

    expect(renderProvider()).toBe(WorkspaceMenuProjectionStatus.Ready);
  });
});

describe("ISS-12475 direct sign-in", () => {
  test("opens the provider-neutral sign-in form without a guest run", async () => {
    authState.status = DesktopAuthStatus.SignedOut;
    renderAdapter()?.requestSignIn?.();
    await waitFor(() =>
      expect(authState.beginSignIn).toHaveBeenCalledWith(
        DesktopSignInMethod.Email,
        undefined,
        DesktopSignInFraming.SignIn
      )
    );
  });

  test.each([
    DesktopAuthStatus.Authenticated,
    DesktopAuthStatus.Loading,
    DesktopAuthStatus.OpeningBrowser,
    DesktopAuthStatus.AwaitingRedirect,
    DesktopAuthStatus.Exchanging,
  ])("withholds sign-in in %s", (status) => {
    authState.status = status;
    expect(renderAdapter()?.requestSignIn).toBeUndefined();
  });
});
