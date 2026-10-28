import { CollaborationProviderWrapper } from "@repo/app/documents/components/collaboration-provider-wrapper";
import { ApiError } from "@repo/app/shared/api/api-error";
import type { createResolveRoomsInfo } from "@repo/app/shared/lib/room-resolvers";
import { LiveblocksAvailabilityContext } from "@repo/collaboration/client/liveblocks-error-boundary";
import { generateDocumentRoomId } from "@repo/collaboration/shared/room-utils";
import { render, screen } from "@testing-library/react";
import { Component, type ReactNode, useContext, useEffect } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

/**
 * ISS-6723: this wrapper sits in the authenticated shell, so a failure here is
 * app-wide — and the only test that named it before this suite `vi.mock`ed it
 * away. Everything below mounts the REAL wrapper; only its external SDK seams
 * (the Liveblocks provider, the user reads, the API transport) are doubled.
 * Nothing stands in for an error boundary either: whether this wrapper mounts
 * one is exactly what the bootstrap failure case below is about (ISS-10202).
 */

const useCurrentUserMock = vi.fn();
const useOrganizationUsersMock = vi.fn();
const postRawMock = vi.fn();

// The resolver the wrapper hands down is exactly what `createResolveRoomsInfo`
// returns, so derive the type from the production factory rather than restating
// its signature here.
type RoomsInfoResolver = ReturnType<typeof createResolveRoomsInfo>;

// Records the props the wrapper hands the provider on every render.
type ProviderCall = {
  authEndpoint: (room?: string) => Promise<unknown>;
  resolveRoomsInfo?: RoomsInfoResolver;
  users?: unknown;
};
const providerCalls: ProviderCall[] = [];

vi.mock("@repo/collaboration/client/top-level-collaboration-provider", () => ({
  TopLevelCollaborationProvider: ({
    children,
    authEndpoint,
    resolveRoomsInfo,
    users,
  }: {
    children: React.ReactNode;
    authEndpoint: (room?: string) => Promise<unknown>;
    resolveRoomsInfo?: RoomsInfoResolver;
    users?: unknown;
  }) => {
    providerCalls.push({ authEndpoint, resolveRoomsInfo, users });
    return <div data-testid="full-provider">{children}</div>;
  },
}));

vi.mock("@repo/app/users/hooks/use-users", () => ({
  useCurrentUser: () => useCurrentUserMock(),
  useOrganizationUsers: () => useOrganizationUsersMock(),
}));

vi.mock("@repo/app/shared/api/use-api-client", () => ({
  useApiClient: () => ({ postRaw: postRawMock }),
}));

let shellMounts = 0;

function MountCountingShell() {
  useEffect(() => {
    shellMounts += 1;
  }, []);
  return <span data-testid="shell">shell content</span>;
}

function lastProviderCall(): ProviderCall {
  const call = providerCalls.at(-1);
  if (!call) {
    throw new Error("the wrapper never rendered its provider");
  }
  return call;
}

const RESOLVED_USER = { id: "user-1", organizationId: "org-1" };

function AvailabilityProbe() {
  const { isAvailable } = useContext(LiveblocksAvailabilityContext);
  return <span data-testid="availability">{String(isAvailable)}</span>;
}

const SAME_ORG_ROOM = generateDocumentRoomId("org-1", "ISS-1");

/**
 * The inbox and a same-org room authenticating from their own mount effects on
 * the commit where `/me` lands — through the callback Liveblocks is still
 * holding then, the BOOT render's, because the provider moves its ref in a
 * passive effect of its own that runs after these descendants' (tamsinb, PR
 * #7741).
 */
function AuthOnAvailable() {
  const { isAvailable } = useContext(LiveblocksAvailabilityContext);
  return isAvailable ? <AuthFromBootCallback /> : null;
}

function AuthFromBootCallback() {
  useEffect(() => {
    const bootCallback = providerCalls[0].authEndpoint;
    bootCallback();
    bootCallback(SAME_ORG_ROOM);
  }, []);
  return null;
}

/**
 * A descendant that fails its first `bootstrapThrowBudget` renders, then
 * renders normally so the boundary has something to show after it catches.
 *
 * The budget matters, and 1 is the wrong value. React 19 absorbs the first two
 * throws on its own (the StrictMode double-render plus its synchronous retry of
 * a failed concurrent render), so a throw-once or throw-twice child still ends
 * up on screen with NO error boundary anywhere — a test built on one passes
 * against the very deletion it claims to catch. Measured against react-dom
 * 19.2.8: at a budget of 3 the throw escapes React's own absorption and only a
 * boundary can stop it, while a budget of ~8 outlives the boundary's recovery
 * too. 3 is the smallest budget inside that window, and `throwCount` is
 * asserted below so this mechanism cannot quietly stop working.
 */
const bootstrapThrowBudget = 3;
const bootstrapFailureMessage = "Liveblocks bootstrap failed";
let throwCount = 0;

function ThrowingDescendant() {
  if (throwCount < bootstrapThrowBudget) {
    throwCount += 1;
    throw new Error(bootstrapFailureMessage);
  }
  return <span data-testid="descendant">descendant content</span>;
}

/**
 * Stands in for the route's `error.tsx`: the boundary the authenticated shell's
 * failures are supposed to reach. Records the message so a case can assert WHAT
 * escaped the wrapper rather than merely that something did.
 */
class RecordingBoundary extends Component<
  { children: ReactNode; onCaught: (message: string) => void },
  { hasError: boolean }
> {
  constructor(props: { children: ReactNode; onCaught: (m: string) => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch(error: unknown): void {
    this.props.onCaught(error instanceof Error ? error.message : String(error));
  }

  render(): ReactNode {
    if (this.state.hasError) {
      return <span data-testid="recording-fallback">recovery UI</span>;
    }
    return this.props.children;
  }
}

// React recovers a failed CONCURRENT render by re-rendering the whole root
// synchronously, then announcing that recovery through the root's
// `onRecoverableError`. That announcement is separate from the boundary catch
// and happens even though the boundary did its job. React's default handler is
// `reportError`, which in jsdom leaves the test as a process-level uncaught
// exception, and vitest fails the entire RUN on an uncaught exception even when
// no assertion failed. Reading each announcement off this one root is what
// keeps the throw, the recovery, and the boundary catch all intact.
function recoveredCauseMessage(error: unknown): string | undefined {
  const cause = error instanceof Error ? error.cause : undefined;
  return cause instanceof Error ? cause.message : undefined;
}

describe("CollaborationProviderWrapper", () => {
  beforeEach(() => {
    providerCalls.length = 0;
    useCurrentUserMock.mockReset();
    useOrganizationUsersMock.mockReset();
    postRawMock.mockReset();
    useOrganizationUsersMock.mockReturnValue({ data: [] });
    throwCount = 0;
    shellMounts = 0;
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  test("keeps the authenticated shell mounted when /me resolves", () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });
    const tree = () => (
      <CollaborationProviderWrapper>
        <MountCountingShell />
        <AvailabilityProbe />
      </CollaborationProviderWrapper>
    );

    const { rerender } = render(tree());
    const bootShell = screen.getByTestId("shell");
    expect(screen.getByTestId("availability")).toHaveTextContent("false");

    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    rerender(tree());

    // The flip to available proves the resolved-user render happened, so the
    // identity check below compares the boot shell against the final one.
    expect(screen.getByTestId("availability")).toHaveTextContent("true");
    expect(screen.getByTestId("shell")).toBe(bootShell);
    expect(shellMounts).toBe(1);
  });

  test("gates inbox hooks off with isAvailable=false during bootstrap", () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });

    render(
      <CollaborationProviderWrapper>
        <AvailabilityProbe />
      </CollaborationProviderWrapper>
    );

    // The context default is `true`, so reading `false` here proves the
    // wrapper actively published the unavailable value rather than the probe
    // falling through to the context's own default.
    expect(screen.getByTestId("availability")).toHaveTextContent("false");
  });

  test("joins the collaboration room with org-scoped room resolution once the user resolves", async () => {
    // The resolver falls back to slug-based names when this lookup fails, which
    // is the branch that still discriminates by organization — so a non-ok
    // response keeps the assertion below on the wrapper's scoping, not on the
    // resolve endpoint's payload.
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    useCurrentUserMock.mockReturnValue({
      data: { id: "user-1", organizationId: "org-1" },
      isLoading: false,
    });
    useOrganizationUsersMock.mockReturnValue({
      data: [
        {
          id: "user-1",
          firstName: "Ada",
          lastName: "Lovelace",
          email: "ada@example.com",
          avatarUrl: "https://example.test/ada.png",
          active: true,
          // Fields the projection must DROP. Without them a fixture already
          // shaped like UserInfo passes even if the projection is deleted and
          // the raw roster is forwarded — which in production would push
          // clerkId/role into Liveblocks room presence.
          clerkId: "user_clerk_1",
          organizationId: "org-1",
          role: "APPROVER",
        },
      ],
    });

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    expect(screen.getByText("shell content")).toBeInTheDocument();
    const full = lastProviderCall();
    // Asserting the resolver merely EXISTS cannot tell a resolver built on the
    // current organization from one built on a stale or hard-coded id — both
    // are functions. So drive it: a room in the current org must resolve, and a
    // room in a foreign org must not. A wrapper that closed over the wrong id
    // fails on the first of these, which is what makes this org scoping
    // (a security boundary) actually tested rather than merely claimed.
    const rooms = await full.resolveRoomsInfo?.({
      roomIds: [
        generateDocumentRoomId("org-1", "in-org-doc"),
        generateDocumentRoomId("org-2", "foreign-doc"),
      ],
    });
    expect(rooms).toEqual([{ name: "in-org-doc", url: undefined }, undefined]);
    // The org roster is projected to the provider's UserInfo shape — mention
    // suggestions and avatars read these exact fields.
    expect(full.users).toEqual([
      {
        id: "user-1",
        firstName: "Ada",
        lastName: "Lovelace",
        email: "ada@example.com",
        avatarUrl: "https://example.test/ada.png",
        active: true,
      },
    ]);
  });

  test("resolves no room for a user carrying no organization id", async () => {
    // A user without an org has no room namespace to resolve against, so every
    // room — including one named for an org — must come back unresolved. The
    // resolver is still a function: the provider keeps the first one it sees.
    useCurrentUserMock.mockReturnValue({
      data: { id: "user-1", organizationId: undefined },
      isLoading: false,
    });

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const rooms = await lastProviderCall().resolveRoomsInfo?.({
      roomIds: [generateDocumentRoomId("org-1", "some-doc")],
    });
    expect(rooms).toEqual([undefined]);
    // The shell still renders — no org is not an error state.
    expect(screen.getByText("shell content")).toBeInTheDocument();
  });

  test("translates a 401 room-auth rejection into Liveblocks' resolved {error} contract", async () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });
    postRawMock.mockRejectedValue(new ApiError("nope", 401));

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = providerCalls[0];

    // Liveblocks' auth callback contract expects an auth FAILURE to RESOLVE to
    // `{ error }`. A rejection here surfaces as an unhandled provider error
    // instead of a clean "not authorized for this room", so the resolved shape
    // is the contract, not an implementation detail.
    await expect(authEndpoint("room-1")).resolves.toEqual({
      error: "forbidden",
      reason: "Not authorized for this Liveblocks room",
    });
    expect(postRawMock).toHaveBeenCalledWith("/collaboration/auth", {
      room: "room-1",
    });
  });

  test("still rejects a non-auth transport failure instead of masking it as forbidden", async () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });
    postRawMock.mockRejectedValue(new ApiError("boom", 500));

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = providerCalls[0];

    // A 500 is not an authorization decision. Resolving it to `{ error:
    // "forbidden" }` would tell the user they lack access to a room they can
    // actually reach, and would hide a real outage.
    await expect(authEndpoint("room-1")).rejects.toThrow("boom");
  });

  test("shares one in-flight token request between the inbox and a room in the caller's organization", async () => {
    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    let release: (value: { token: string }) => void = () => undefined;
    postRawMock.mockReturnValue(
      new Promise((resolve) => {
        release = resolve;
      })
    );

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = lastProviderCall();
    const inbox = authEndpoint();
    const room = authEndpoint(generateDocumentRoomId("org-1", "ISS-1"));
    release({ token: "org-token" });

    await expect(inbox).resolves.toEqual({ token: "org-token" });
    await expect(room).resolves.toEqual({ token: "org-token" });
    expect(postRawMock).toHaveBeenCalledTimes(1);
  });

  test("shares the token request made on the commit where /me lands", () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });
    postRawMock.mockReturnValue(new Promise(() => undefined));
    const tree = () => (
      <CollaborationProviderWrapper>
        <AuthOnAvailable />
      </CollaborationProviderWrapper>
    );

    const { rerender } = render(tree());
    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    rerender(tree());

    expect(lastProviderCall().authEndpoint).toBe(providerCalls[0].authEndpoint);
    expect(postRawMock).toHaveBeenCalledTimes(1);
  });

  test("sends the shared request without the room that happened to ask first", async () => {
    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    postRawMock.mockResolvedValue({ token: "org-token" });

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = lastProviderCall();
    const room = authEndpoint(SAME_ORG_ROOM);
    const inbox = authEndpoint();

    await expect(room).resolves.toEqual({ token: "org-token" });
    await expect(inbox).resolves.toEqual({ token: "org-token" });
    expect(postRawMock).toHaveBeenCalledTimes(1);
    expect(postRawMock.mock.calls[0]).toEqual([
      "/collaboration/auth",
      { room: undefined },
    ]);
  });

  test("asks the server about a room in another organization instead of reusing the caller's token", () => {
    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    postRawMock.mockReturnValue(new Promise(() => undefined));
    const foreignRoom = generateDocumentRoomId("org-2", "ISS-9");

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = lastProviderCall();
    authEndpoint();
    authEndpoint(foreignRoom);

    expect(postRawMock).toHaveBeenCalledTimes(2);
    expect(postRawMock).toHaveBeenLastCalledWith("/collaboration/auth", {
      room: foreignRoom,
    });
  });

  test("requests a new token once the shared request has settled", async () => {
    // Liveblocks re-authenticates when a token nears expiry; handing it the
    // settled answer again would give it the token it is trying to replace.
    useCurrentUserMock.mockReturnValue({
      data: RESOLVED_USER,
      isLoading: false,
    });
    postRawMock
      .mockResolvedValueOnce({ token: "first" })
      .mockResolvedValueOnce({ token: "second" });

    render(
      <CollaborationProviderWrapper>
        <span>shell content</span>
      </CollaborationProviderWrapper>
    );

    const { authEndpoint } = lastProviderCall();
    await expect(authEndpoint()).resolves.toEqual({ token: "first" });
    await expect(
      authEndpoint(generateDocumentRoomId("org-1", "ISS-1"))
    ).resolves.toEqual({ token: "second" });
    expect(postRawMock).toHaveBeenCalledTimes(2);
  });

  test("lets a bootstrap descendant's throw escape to the boundary above", () => {
    useCurrentUserMock.mockReturnValue({ data: undefined, isLoading: true });
    // React logs the caught error; silence it so a PASSING run is not noisy.
    const consoleError = vi
      .spyOn(console, "error")
      .mockImplementation(() => undefined);
    const recoveredCauses: (string | undefined)[] = [];
    const escaped: string[] = [];

    try {
      render(
        <RecordingBoundary onCaught={(message) => escaped.push(message)}>
          <CollaborationProviderWrapper>
            <ThrowingDescendant />
          </CollaborationProviderWrapper>
        </RecordingBoundary>,
        // Scoped to THIS root only. Every other render in the project keeps
        // React's default reporting, so a genuine uncaught error anywhere else
        // still fails the run — and the notices collected here are asserted
        // below rather than dropped, so an unexpected recovery on this root
        // fails this test instead of disappearing.
        {
          onRecoverableError: (error) =>
            recoveredCauses.push(recoveredCauseMessage(error)),
        }
      );

      // ISS-10202 changed this expectation deliberately. `children` here is the
      // whole authenticated shell, and the boundary this branch used to mount
      // re-rendered whatever it caught — so a render failure anywhere in the
      // app was absorbed at this height and the route's `error.tsx` never
      // rendered its recovery UI. The shell's failures now reach the boundary
      // above, which is what `RecordingBoundary` stands in for; the bootstrap
      // window's inbox gate is unaffected and is pinned separately above.
      expect(escaped).toEqual([bootstrapFailureMessage]);
      expect(screen.getByTestId("recording-fallback")).toBeInTheDocument();
      expect(screen.queryByTestId("descendant")).not.toBeInTheDocument();
      // The child really did throw, the full budget, past everything React
      // absorbs on its own — so the assertions above cannot be satisfied by a
      // run in which nothing ever failed. This also pins the mechanism: if a
      // React upgrade changes how many throws it swallows, this count moves and
      // the window documented on `bootstrapThrowBudget` gets re-derived instead
      // of the test quietly going back to proving nothing.
      expect(throwCount).toBe(bootstrapThrowBudget);
      // Whether React announces a root-level recovery at all is its own
      // implementation detail, and with a boundary above the wrapper it no
      // longer does — so only the identity of anything it DOES announce is
      // pinned here. That the throw was real is pinned by `throwCount` and by
      // `escaped` above, neither of which a quiet run can satisfy.
      expect(
        recoveredCauses.filter((cause) => cause !== bootstrapFailureMessage)
      ).toEqual([]);
    } finally {
      consoleError.mockRestore();
    }
  });
});
