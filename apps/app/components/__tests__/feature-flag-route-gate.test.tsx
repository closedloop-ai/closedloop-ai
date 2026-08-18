import { FEATURE_FLAG_SETTLE_TIMEOUT_MS as FLAG_SETTLE_TIMEOUT_MS } from "@repo/app/shared/components/feature-flag-pending";
import { act, render, screen } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { FeatureFlagRouteGate } from "../feature-flag-route-gate";

const PAST_SETTLE_DEADLINE_MS = FLAG_SETTLE_TIMEOUT_MS + 1;

// FEA-4228: `FeatureFlagRouteGate` is the canonical graceful-degradation
// wrapper for the flag-gated Sessions/Branches routes. When the flag resolves
// OFF for the SIGNED-IN user it must call `notFound()` (→ the in-shell "Page
// not found" recovery state), NEVER render a blank fallback. During the
// pre-mount + still-resolving window — and, critically, during the
// anonymous-bootstrap → identify() → post-identify flag-reload handshake — it
// renders the `pending` chrome (Header + skeleton) rather than committing the
// one-way 404. A flag that is off for the anonymous cookie distinct id but on
// for the identified user must land on the real page, not the 404. These
// behavioral tests drive the resolved-OFF, resolved-ON, still-resolving, and
// false-before-identify → true-after-identify branches directly.

const { notFoundMock, useFeatureFlagMock } = vi.hoisted(() => ({
  notFoundMock: vi.fn(() => {
    throw new Error("NEXT_NOT_FOUND");
  }),
  useFeatureFlagMock: vi.fn(),
}));

const { useFeatureFlagsLoadedMock, usePostHogDistinctIdMock } = vi.hoisted(
  () => ({
    useFeatureFlagsLoadedMock: vi.fn(),
    usePostHogDistinctIdMock: vi.fn(),
  })
);

// Whether the build has a PostHog key at all. Mutable because it selects
// between two genuinely different worlds: a live client with an
// anonymous-bootstrap → identify() handshake to wait on, and a fixture-resolved
// build with no handshake and no distinct id to compare against.
const { postHogState } = vi.hoisted(() => ({ postHogState: { live: true } }));

const { useUserMock } = vi.hoisted(() => ({ useUserMock: vi.fn() }));

const { useOrgPathMock } = vi.hoisted(() => ({
  useOrgPathMock: vi.fn(() => (path: string) => `/org-slug${path}`),
}));

vi.mock("@repo/navigation/use-org-path", () => ({
  useOrgPath: () => useOrgPathMock(),
}));

// Render the navigation Link as a plain anchor so the recovery affordance is
// inspectable without mounting a navigation provider.
vi.mock("@repo/navigation/link", () => ({
  Link: ({
    children,
    href,
    className,
  }: {
    children: ReactNode;
    href: string;
    className?: string;
  }) => (
    <a className={className} href={href}>
      {children}
    </a>
  ),
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
}));

vi.mock("@repo/analytics/client", () => ({
  // A getter, not a literal: the module is evaluated once, and the
  // PostHog-disabled build is a per-test condition.
  get postHogFeatureFlagsEnabled() {
    return postHogState.live;
  },
  useFeatureFlag: (flag: string) => useFeatureFlagMock(flag),
  useFeatureFlagsLoaded: () => useFeatureFlagsLoadedMock(),
  usePostHogDistinctId: () => usePostHogDistinctIdMock(),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: () => useUserMock(),
}));

const TEST_FLAG = "sessions-nav";
const GATED_CHILD_TEXT = "Gated body";
const PENDING_CHROME_TEXT = "Route chrome";
const IDENTIFIED_USER_ID = "user_identified_123";

function GatedChild() {
  return <div>{GATED_CHILD_TEXT}</div>;
}

/** The steady state: signed-in user identified in PostHog, flags loaded. */
function settledIdentifiedState() {
  useUserMock.mockReturnValue({
    isLoaded: true,
    user: { id: IDENTIFIED_USER_ID },
  });
  useFeatureFlagsLoadedMock.mockReturnValue(true);
  usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
}

function renderGate() {
  return render(
    <FeatureFlagRouteGate
      flag={TEST_FLAG}
      pending={<div>{PENDING_CHROME_TEXT}</div>}
    >
      <GatedChild />
    </FeatureFlagRouteGate>
  );
}

describe("FeatureFlagRouteGate", () => {
  beforeEach(() => {
    notFoundMock.mockClear();
    useFeatureFlagMock.mockReset();
    useFeatureFlagsLoadedMock.mockReset();
    usePostHogDistinctIdMock.mockReset();
    useUserMock.mockReset();
    postHogState.live = true;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("degrades a resolved-off flag to notFound() for the identified user, never a blank body", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    // notFound() throws NEXT_NOT_FOUND, which the App Router turns into the
    // in-shell not-found page — the graceful recovery state, not a blank void.
    expect(() => renderGate()).toThrow("NEXT_NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalled();
    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
  });

  it("renders the real body when the flag resolves on", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    renderGate();

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("renders neither the body nor notFound() while the flag is still resolving", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue(undefined);

    renderGate();

    // Transient unresolved window: no blank-vs-404 flicker either way. This
    // window is now BOUNDED — see the settle-deadline tests below.
    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("renders the pending chrome (not nothing) while the flag is still resolving", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue(undefined);

    renderGate();

    // FEA-4228: the route opens with its chrome shell in place, not a blank
    // content region — the real body and notFound() are both withheld until the
    // flag resolves.
    expect(screen.getByText(PENDING_CHROME_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("swaps the pending chrome for the real body once the flag resolves on", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    renderGate();

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(PENDING_CHROME_TEXT)).not.toBeInTheDocument();
  });

  it("does NOT 404 on a false flag while the user is not yet identified in PostHog (anonymous bootstrap)", () => {
    // wongk (thread 1): PostHog bootstraps against the anonymous cookie distinct
    // id and can resolve the flag OFF before identify() runs. Committing 404 here
    // throws the route away for a user whose flag is actually enabled. Hold the
    // pending chrome until the identified user's flags have landed.
    useUserMock.mockReturnValue({
      isLoaded: true,
      user: { id: IDENTIFIED_USER_ID },
    });
    useFeatureFlagsLoadedMock.mockReturnValue(true);
    usePostHogDistinctIdMock.mockReturnValue("anon_cookie_id"); // NOT the user id
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    renderGate();

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByText(PENDING_CHROME_TEXT)).toBeInTheDocument();
    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
  });

  it("does NOT 404 on a false flag while PostHog has not finished loading the identified flags", () => {
    useUserMock.mockReturnValue({
      isLoaded: true,
      user: { id: IDENTIFIED_USER_ID },
    });
    useFeatureFlagsLoadedMock.mockReturnValue(false); // flags not loaded yet
    usePostHogDistinctIdMock.mockReturnValue(IDENTIFIED_USER_ID);
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    renderGate();

    expect(notFoundMock).not.toHaveBeenCalled();
    expect(screen.getByText(PENDING_CHROME_TEXT)).toBeInTheDocument();
  });

  it("renders the body when the flag was false pre-identify but resolves on after identify (false→true)", () => {
    // The exact regression wongk called out: false before identify, true after.
    // Once identify() lands and the reloaded flag reads enabled, the real body
    // renders — the route is never thrown away.
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    renderGate();

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("renders the body immediately on an enabled flag even before the identify handshake settles", () => {
    // An enabled flag is authoritative and non-blocking — never gate the body
    // behind the identify handshake, only the one-way 404.
    useUserMock.mockReturnValue({ isLoaded: false, user: undefined });
    useFeatureFlagsLoadedMock.mockReturnValue(false);
    usePostHogDistinctIdMock.mockReturnValue(undefined);
    useFeatureFlagMock.mockReturnValue({ enabled: true });

    renderGate();

    expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
    expect(notFoundMock).not.toHaveBeenCalled();
  });

  it("404s a false flag immediately in a build with no PostHog key, where there is no handshake to wait on", () => {
    // Containerized E2E and local dev have no PostHog key, so `useFeatureFlag`
    // resolves synchronously off the local fixture: the flag was decided on the
    // very first render. There is also no distinct id, which the identity check
    // reads as "not identified" — so without the carve-out this build holds every
    // gated surface open until the bounded deadline and then shows a failed-read
    // state, for a flag that never had anything to settle.
    postHogState.live = false;
    useUserMock.mockReturnValue({
      isLoaded: true,
      user: { id: IDENTIFIED_USER_ID },
    });
    useFeatureFlagsLoadedMock.mockReturnValue(true);
    usePostHogDistinctIdMock.mockReturnValue(undefined);
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    expect(() => renderGate()).toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  it("404s a signed-out user on a false flag once flags have loaded (no user id to wait on)", () => {
    // A signed-out route has no user id to identify; a resolved distinct id +
    // loaded flags is the settled state, so a false flag is terminal.
    useUserMock.mockReturnValue({ isLoaded: true, user: null });
    useFeatureFlagsLoadedMock.mockReturnValue(true);
    usePostHogDistinctIdMock.mockReturnValue("anon_cookie_id");
    useFeatureFlagMock.mockReturnValue({ enabled: false });

    expect(() => renderGate()).toThrow("NEXT_NOT_FOUND");
    expect(notFoundMock).toHaveBeenCalled();
  });

  // ISS-5001: `useFeatureFlag` returns `undefined` both for "still loading" and
  // for "this key does not exist / PostHog never initialized", so the gate used
  // to fall through to `pending` forever. With the default `pending` of `null`,
  // that rendered /issues, /routines and /loops/usage as a permanently empty
  // content region. These drive a flag that NEVER resolves and assert the gate
  // reaches a terminal, non-blank state.
  describe("bounded settle deadline", () => {
    it("degrades a never-resolving flag to a stated unavailable state, not a blank void", () => {
      vi.useFakeTimers();
      settledIdentifiedState();
      useFeatureFlagMock.mockReturnValue(undefined);

      renderGate();
      act(() => {
        vi.advanceTimersByTime(PAST_SETTLE_DEADLINE_MS);
      });

      // Terminal, visible, and actionable — the fact stated is "we could not
      // check", which is what actually happened.
      expect(screen.getByText("Couldn't load this page")).toBeInTheDocument();
      expect(
        screen.getByRole("button", { name: "Try again" })
      ).toBeInTheDocument();
      // A reload lands on another bounded wait, so a second way out matters if
      // the flag source is genuinely down.
      expect(
        screen.getByRole("link", { name: "Back to dashboard" })
      ).toBeInTheDocument();
      // Announced, not silently swapped in under a role="status" region.
      expect(screen.getByRole("alert")).toBeInTheDocument();
      // Fails CLOSED: the gated body is still never rendered.
      expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
      // An unresolved flag is NOT the same fact as a deliberately gated route,
      // so it must not claim the page does not exist.
      expect(notFoundMock).not.toHaveBeenCalled();
    });

    it("never 404s at the deadline while the identify handshake is unsettled (FEA-4228 must not regress)", () => {
      vi.useFakeTimers();
      useUserMock.mockReturnValue({
        isLoaded: true,
        user: { id: IDENTIFIED_USER_ID },
      });
      useFeatureFlagsLoadedMock.mockReturnValue(true);
      // identify() never lands: PostHog stays on the anonymous cookie id, so the
      // `false` here is the ANONYMOUS flag set and may be `true` for this user.
      usePostHogDistinctIdMock.mockReturnValue("anon_cookie_id");
      useFeatureFlagMock.mockReturnValue({ enabled: false });

      renderGate();
      expect(notFoundMock).not.toHaveBeenCalled();

      act(() => {
        vi.advanceTimersByTime(PAST_SETTLE_DEADLINE_MS);
      });

      // Terminal and non-blank, but NOT the one-way 404: telling a user whose
      // flag may be on that the page does not exist would be a lie, and a
      // reload would re-run the same race.
      expect(screen.getByText("Couldn't load this page")).toBeInTheDocument();
      expect(notFoundMock).not.toHaveBeenCalled();
      expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
    });

    it("still 404s a settled resolved-off flag, without waiting for the deadline", () => {
      vi.useFakeTimers();
      settledIdentifiedState();
      useFeatureFlagMock.mockReturnValue({ enabled: false });

      // The settled path is terminal immediately; the deadline is not involved.
      expect(() => renderGate()).toThrow("NEXT_NOT_FOUND");
      expect(notFoundMock).toHaveBeenCalled();
    });

    it("still renders the body when the flag resolves on before the deadline", () => {
      vi.useFakeTimers();
      settledIdentifiedState();
      useFeatureFlagMock.mockReturnValue({ enabled: true });

      renderGate();
      act(() => {
        vi.advanceTimersByTime(PAST_SETTLE_DEADLINE_MS);
      });

      expect(screen.getByText(GATED_CHILD_TEXT)).toBeInTheDocument();
      expect(notFoundMock).not.toHaveBeenCalled();
    });

    it("clears the settle timer on unmount", () => {
      vi.useFakeTimers();
      settledIdentifiedState();
      useFeatureFlagMock.mockReturnValue(undefined);

      const { unmount } = renderGate();
      unmount();

      expect(vi.getTimerCount()).toBe(0);
    });
  });

  it("defaults `pending` to a visible loading state, never a blank region", () => {
    settledIdentifiedState();
    useFeatureFlagMock.mockReturnValue(undefined);

    // No `pending` passed — the case for a gated route whose loaded page has no
    // Header of its own to reserve (`/insights`).
    render(
      <FeatureFlagRouteGate flag={TEST_FLAG}>
        <GatedChild />
      </FeatureFlagRouteGate>
    );

    expect(
      screen.getByRole("status", { name: "Loading page" })
    ).toBeInTheDocument();
    expect(screen.queryByText(GATED_CHILD_TEXT)).not.toBeInTheDocument();
  });
});
