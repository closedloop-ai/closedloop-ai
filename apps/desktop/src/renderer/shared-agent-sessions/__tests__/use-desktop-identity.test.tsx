import { renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { DesktopIdentity } from "../../types/desktop-api";
import {
  resetDesktopIdentityCacheForTests,
  useDesktopIdentity,
} from "../use-desktop-identity";

/**
 * ISS-5366 (#4579 stage review): `useDesktopIdentity` was a bare
 * `useState(null)` + effect with NO cache, so every hook INSTANCE issued its own
 * `GET /desktop/identity` and every one of them started from `null`.
 *
 * Two consequences, and the session-detail "Linked artifacts" row paid for both.
 * It gates its pills on `identity?.organizationSlug`, so each mount rendered the
 * settled "not reachable" label first and flipped to a link once the IPC landed
 * — the row asserting something it had not checked. And the sidebar AccountMenu,
 * the Settings Account tab and every detail mount each paid for a round trip
 * that had already been made.
 *
 * So the contract under test is: the payload is cached and deduped, and `null`
 * now carries `isResolved` so a caller can tell "not known YET" from "there is
 * no identity".
 */
const IDENTITY: DesktopIdentity = {
  email: "ada@example.com",
  firstName: "Ada",
  lastName: "Lovelace",
  organizationId: "org-1",
  organizationName: "Acme",
  // The field the linked-artifact pills actually gate on (ISS-4898).
  organizationSlug: "acme",
  userId: "u-1",
};

function installIdentity(impl: () => Promise<DesktopIdentity | null>) {
  const getDesktopIdentity = vi.fn(impl);
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: { getDesktopIdentity },
  });
  return getDesktopIdentity;
}

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
  // Module-level state outlives a test file, so a resolved identity would seed
  // the next case's FIRST render and make every pending-window assertion below
  // vacuously true.
  resetDesktopIdentityCacheForTests();
});

describe("useDesktopIdentity (ISS-5366)", () => {
  it("reports unresolved before the fetch settles, then the identity", async () => {
    installIdentity(() => Promise.resolve(IDENTITY));

    const { result } = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "user-1")
    );

    // The window the linked-artifact pills used to render their "not reachable"
    // state into.
    expect(result.current.identity).toBeNull();
    expect(result.current.isResolved).toBe(false);

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.identity).toEqual(IDENTITY);
  });

  it("serves a later mount SYNCHRONOUSLY from cache, with no pending window", async () => {
    const getDesktopIdentity = installIdentity(() => Promise.resolve(IDENTITY));

    const first = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );
    await waitFor(() => expect(first.result.current.isResolved).toBe(true));

    const second = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    // THE fix for the flash: the second mount never renders a transient null, so
    // there is no window in which its pills can claim to be unreachable.
    expect(second.result.current.identity).toEqual(IDENTITY);
    expect(second.result.current.isResolved).toBe(true);
    // Stale-while-revalidate: the cached value seeds the render and the mount
    // still re-reads behind it, so an org rename is picked up next mount.
    await waitFor(() =>
      expect(getDesktopIdentity.mock.calls.length).toBeGreaterThan(1)
    );
  });

  it("shares ONE in-flight request across concurrent mounts", async () => {
    const getDesktopIdentity = installIdentity(() => Promise.resolve(IDENTITY));

    const a = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );
    const b = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    await waitFor(() => expect(a.result.current.isResolved).toBe(true));
    await waitFor(() => expect(b.result.current.isResolved).toBe(true));

    // Two mounts, one round trip — the per-instance fetch the review called out.
    expect(getDesktopIdentity).toHaveBeenCalledTimes(1);
  });

  it("treats signed-out as a SETTLED absence and issues no IPC", () => {
    const getDesktopIdentity = installIdentity(() => Promise.resolve(IDENTITY));

    const { result } = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.SignedOut, null)
    );

    // Settled, not pending: there is no fetch to wait for, so a caller must not
    // hold a loading state — the pills degrade to their honest inert label.
    expect(result.current.identity).toBeNull();
    expect(result.current.isResolved).toBe(true);
    expect(getDesktopIdentity).not.toHaveBeenCalled();
  });

  it("settles to no identity when the fetch rejects", async () => {
    installIdentity(() => Promise.reject(new Error("boom")));

    const { result } = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.identity).toBeNull();
  });

  it("settles when the bridge is absent rather than pending forever", async () => {
    Reflect.deleteProperty(window, "desktopApi");
    Object.defineProperty(window, "desktopApi", {
      configurable: true,
      value: {},
    });

    const { result } = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    // A bridge that will never exist must not strand a caller in its loading
    // state for the life of the view.
    await waitFor(() => expect(result.current.isResolved).toBe(true));
    expect(result.current.identity).toBeNull();
  });
});
