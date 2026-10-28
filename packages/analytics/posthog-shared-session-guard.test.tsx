import { cleanup, render } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  POSTHOG_SESSION_KEY,
  postHogPersistenceName,
  type StoredSession,
} from "./posthog-shared-session";

const TOKEN = "phc_iss12559_guard";
const NAME = postHogPersistenceName(TOKEN);
const T0 = 1_760_000_000_000;
const HOUR = 3_600_000;
const STALE: StoredSession = [T0 - 2 * HOUR, "0199-guard-stale", T0 - 3 * HOUR];
const SHARED: StoredSession = [T0 - 60_000, "0199-guard-shared", T0 - HOUR];
const NEWER: StoredSession = [T0, "0199-guard-newer", T0 - 60_000];

const originalLocalStorage = Object.getOwnPropertyDescriptor(
  globalThis,
  "localStorage"
);

beforeEach(() => {
  // A fresh module per case: the guard's once-per-document latch lives there.
  vi.resetModules();
  globalThis.localStorage.setItem(
    NAME,
    JSON.stringify({ [POSTHOG_SESSION_KEY]: STALE })
  );
  writeCookie({ [POSTHOG_SESSION_KEY]: SHARED });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  Reflect.deleteProperty(globalThis.document, "cookie");
  if (originalLocalStorage) {
    Object.defineProperty(globalThis, "localStorage", originalLocalStorage);
  }
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API; clears the fixture cookie.
  globalThis.document.cookie = `${NAME}=; path=/; max-age=0`;
});

describe("PostHogSharedSessionGuard", () => {
  it("resumes the shared session on its first render", async () => {
    const { PostHogSharedSessionGuard } = await importGuard();

    render(<PostHogSharedSessionGuard token={TOKEN} />);

    expect(localSession()).toEqual([...SHARED]);
  });

  it("runs once per document, not once per mount", async () => {
    const { PostHogSharedSessionGuard } = await importGuard();
    render(<PostHogSharedSessionGuard token={TOKEN} />);
    cleanup();
    writeCookie({ [POSTHOG_SESSION_KEY]: NEWER });

    render(<PostHogSharedSessionGuard token={TOKEN} />);

    // A remount under a live client must not rewrite storage again.
    expect(localSession()).toEqual([...SHARED]);
  });

  it("does nothing during server rendering, and leaves the latch for the browser", async () => {
    const { PostHogSharedSessionGuard } = await importGuard();
    vi.stubGlobal("document", undefined);

    expect(PostHogSharedSessionGuard({ token: TOKEN })).toBeNull();
    expect(localSession()).toEqual([...STALE]);

    vi.unstubAllGlobals();
    render(<PostHogSharedSessionGuard token={TOKEN} />);
    expect(localSession()).toEqual([...SHARED]);
  });

  it("renders when localStorage access throws", async () => {
    const { PostHogSharedSessionGuard } = await importGuard();
    Object.defineProperty(globalThis, "localStorage", {
      configurable: true,
      get() {
        throw new DOMException("blocked", "SecurityError");
      },
    });

    expect(() =>
      render(<PostHogSharedSessionGuard token={TOKEN} />)
    ).not.toThrow();
  });

  it("renders and resumes nothing when document.cookie throws", async () => {
    const { PostHogSharedSessionGuard } = await importGuard();
    Object.defineProperty(globalThis.document, "cookie", {
      configurable: true,
      get() {
        throw new DOMException("opaque origin", "SecurityError");
      },
    });

    expect(() =>
      render(<PostHogSharedSessionGuard token={TOKEN} />)
    ).not.toThrow();
    expect(localSession()).toEqual([...STALE]);
  });
});

function importGuard() {
  return import("./posthog-shared-session-guard");
}

function localSession(): unknown {
  return JSON.parse(globalThis.localStorage.getItem(NAME) ?? "{}")[
    POSTHOG_SESSION_KEY
  ];
}

function writeCookie(record: Record<string, unknown>): void {
  // biome-ignore lint/suspicious/noDocumentCookie: jsdom has no Cookie Store API, and the guard reads `document.cookie`.
  globalThis.document.cookie = `${NAME}=${encodeURIComponent(
    JSON.stringify(record)
  )}; path=/`;
}
