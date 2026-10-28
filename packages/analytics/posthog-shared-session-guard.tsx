"use client";

import {
  resumeSharedSession,
  type SharedSessionStorage,
} from "./posthog-shared-session";

/**
 * ISS-12559: resumes the cross-subdomain PostHog session before posthog-js
 * loads its persistence. Renders nothing.
 *
 * Mounted as the PRECEDING SIBLING of `<PostHogProvider>`, during render. React
 * renders a fragment's children in order, so this runs before
 * `ClientPostHogProvider` calls `posthog.init` in its own render; an effect, or
 * a child of the provider, would run after the persistence constructor has
 * already loaded the stale record and saved it over the shared cookie.
 *
 * Once per document, not per mount: posthog-js initializes once per document,
 * and a remount (the marketing `[locale]` layout on a locale switch) must not
 * rewrite storage under a live client.
 */
export function PostHogSharedSessionGuard({ token }: { token: string }) {
  if (!resumedThisDocument && globalThis.document !== undefined) {
    resumedThisDocument = true;
    const cookieHeader = readDocumentCookie();
    if (cookieHeader !== null) {
      resumeSharedSession({
        token,
        cookieHeader,
        storage: blockableLocalStorage,
      });
    }
  }
  return null;
}

let resumedThisDocument = false;

/**
 * `document.cookie` throws a `SecurityError` in an opaque-origin document
 * (a sandboxed frame). There is nothing to resume from then, and the provider
 * tree must still render.
 */
function readDocumentCookie(): string | null {
  try {
    return globalThis.document.cookie;
  } catch {
    return null;
  }
}

/**
 * Blocked site data makes `localStorage` throw on access, and a full store
 * throws on write. posthog-js then falls back on its own, so either costs
 * continuity and nothing else; any other failure is left to propagate.
 */
const blockableLocalStorage: SharedSessionStorage = {
  getItem(key) {
    try {
      return globalThis.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  setItem(key, value) {
    try {
      globalThis.localStorage.setItem(key, value);
    } catch {
      // posthog-js loads what it can, as it did before this guard.
    }
  },
};
