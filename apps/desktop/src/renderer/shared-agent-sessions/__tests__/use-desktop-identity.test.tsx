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
 * — the row asserting something it had not checked. And the sidebar AccountMenu
 * and every detail mount each paid for a round trip that had already been made.
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

  it("does NOT cache a failed read: a later mount starts pending and re-reads", async () => {
    // ISS-11145 review (tamsinb): the failure used to be written to the cache as
    // a `null` indistinguishable from "this account has no identity", so every
    // later mount seeded from it synchronously and no read ever ran again. A
    // consumer that renders "checking…" while the name is unknown was then
    // announcing a check that had finished for good.
    let attempt = 0;
    const getDesktopIdentity = installIdentity(() => {
      attempt += 1;
      return attempt === 1
        ? Promise.reject(new Error("boom"))
        : Promise.resolve(IDENTITY);
    });

    const first = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );
    await waitFor(() => expect(first.result.current.isResolved).toBe(true));
    expect(first.result.current.identity).toBeNull();

    const second = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    // The failure is not a cached answer, so this mount is genuinely PENDING on
    // first render rather than seeded with a settled absence.
    expect(second.result.current.isResolved).toBe(false);
    expect(second.result.current.identity).toBeNull();

    // ...and the read really does run again, which is what makes the pending
    // claim honest.
    await waitFor(() => expect(second.result.current.isResolved).toBe(true));
    expect(second.result.current.identity).toEqual(IDENTITY);
    expect(getDesktopIdentity).toHaveBeenCalledTimes(2);
  });

  it("DOES cache a read that answered 'no identity', with no pending window", async () => {
    // The other half of the distinction: an ANSWER of `null` is still settled and
    // still seeds a later mount synchronously, so not-caching failures did not
    // reintroduce the ISS-5366 flash for a genuine absence.
    const getDesktopIdentity = installIdentity(() => Promise.resolve(null));

    const first = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );
    await waitFor(() => expect(first.result.current.isResolved).toBe(true));

    const second = renderHook(() =>
      useDesktopIdentity(DesktopAuthStatus.Authenticated, "u-1")
    );

    expect(second.result.current.isResolved).toBe(true);
    expect(second.result.current.identity).toBeNull();
    await waitFor(() =>
      expect(getDesktopIdentity.mock.calls.length).toBeGreaterThan(1)
    );
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
