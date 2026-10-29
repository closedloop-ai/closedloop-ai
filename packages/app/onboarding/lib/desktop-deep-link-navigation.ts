import { DESKTOP_DEEP_LINK_URL } from "@repo/api/src/types/desktop-deep-link";

/**
 * Fire the OS-registered `closedloop://` link, which starts or focuses the
 * desktop app.
 *
 * A one-line module for the same reason {@link redirectToDesktopLoopback} is
 * one: `window.location` is non-configurable under jsdom, so a whole-document
 * navigation cannot be spied on in place — the seam a test can take hold of has
 * to be the module. Every other navigation in this feature is already shaped
 * this way.
 *
 * PAYLOAD-FREE, and the constant is the whole URL rather than a base to append
 * to. The desktop's validator denies any host, path, query, fragment or
 * credentials by default (`apps/desktop/src/main/lifecycle/deep-link.ts`), so a
 * link carrying onboarding or walkthrough state would be refused outright
 * rather than acted on. The desktop's own held state is what decides where its
 * run resumes; nothing about it travels through here.
 *
 * The call is UNOBSERVABLE: an unregistered or refused scheme no-ops with no
 * error and no event, so this returns nothing and no caller may read a success
 * from it.
 */
export function openDesktopApp(): void {
  globalThis.location.assign(DESKTOP_DEEP_LINK_URL);
}
