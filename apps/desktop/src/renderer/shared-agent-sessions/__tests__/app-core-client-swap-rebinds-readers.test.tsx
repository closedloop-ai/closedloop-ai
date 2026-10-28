import { useQuery, useQueryClient } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopAuthStatus } from "../../../shared/contracts";
import type { SyncConsentRecord } from "../../../shared/sync-consent";
import type { DesktopAuthState } from "../../types/desktop-api";
import { DesktopAppCoreMode } from "../desktop-app-core-mode";
import {
  DesktopAppCoreProvider,
  useDesktopAppCoreMode,
} from "../desktop-app-core-provider";

/**
 * A mounted reader must follow the `QueryClient` this provider swaps under it.
 *
 * `useDesktopAppCoreStack` builds a NEW client on every mode change, and React
 * Query binds an observer to the client present at its FIRST render and never
 * rebinds it when the context value changes. So without a remount the swap
 * reaches `useQueryClient()` — every imperative `setQueryData`/`getQueryData`,
 * and every mutation's cache write — while leaving already-mounted `useQuery`
 * readers on the discarded client's cache for the life of the app. Nothing
 * errors: the reader keeps rendering the last value it saw, so a write lands
 * and the screen simply never moves.
 *
 * That is what kept the resumed sync step off screen (ISS-11249): the
 * checklist's transition was accepted and persisted, and the modal's own
 * snapshot query was still bound to the pre-flip client.
 *
 * The flip here is the production one — offline to online promotes Local to
 * Cloud — and the assertion is the crossing itself rather than any onboarding
 * copy, because the defect belongs to this provider and reaches every desktop
 * query.
 */

const AUTHENTICATED: DesktopAuthState = {
  status: DesktopAuthStatus.Authenticated,
  userId: "user-1",
  organizationId: "org-1",
};

const CONSENTED: SyncConsentRecord = {
  tier: "full",
  organizationId: "org-1",
  bound: true,
};

const PROBE_KEY = ["app-core-client-swap-probe"] as const;
const SEEDED = "seeded-before-the-swap";
const WRITTEN_AFTER_SWAP = "written-through-the-current-client";

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function setupDesktopApi() {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDesktopAuthState: vi.fn(() => Promise.resolve(AUTHENTICATED)),
      onDesktopAuthStateChanged: vi.fn(() => () => {
        // no auth transitions in this suite
      }),
      getSyncConsentRecord: vi.fn(() => Promise.resolve(CONSENTED)),
    },
  });
}

function forceOnline(value: boolean): () => void {
  const original = Object.getOwnPropertyDescriptor(window.navigator, "onLine");
  Object.defineProperty(window.navigator, "onLine", {
    configurable: true,
    value,
  });
  return () => {
    if (original) {
      Object.defineProperty(window.navigator, "onLine", original);
    } else {
      Reflect.deleteProperty(window.navigator, "onLine");
    }
  };
}

let restoreOnline: (() => void) | null = null;

afterEach(() => {
  restoreOnline?.();
  restoreOnline = null;
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
});

describe("Desktop app-core client swap", () => {
  it("leaves a mounted reader on the client its own writes now reach", async () => {
    restoreOnline = forceOnline(false);
    setupDesktopApi();

    const { result, rerender } = renderHook(
      () => ({
        client: useQueryClient(),
        mode: useDesktopAppCoreMode(),
        probe: useQuery({
          queryFn: () => SEEDED,
          queryKey: PROBE_KEY,
          staleTime: Number.POSITIVE_INFINITY,
        }),
      }),
      { wrapper: DesktopAppCoreProvider }
    );

    await waitFor(() => {
      expect(result.current.mode).toBe(DesktopAppCoreMode.Local);
    });
    await waitFor(() => {
      expect(result.current.probe.data).toBe(SEEDED);
    });

    restoreOnline();
    restoreOnline = forceOnline(true);
    rerender();

    await waitFor(() => {
      expect(result.current.mode).toBe(DesktopAppCoreMode.Cloud);
    });

    // The write every mutation's `onSuccess` performs: through the client the
    // tree resolves RIGHT NOW. A reader still bound to the discarded client
    // never sees it, which is the defect rather than a slow update.
    act(() => {
      result.current.client.setQueryData(PROBE_KEY, WRITTEN_AFTER_SWAP);
    });

    await waitFor(() => {
      expect(result.current.probe.data).toBe(WRITTEN_AFTER_SWAP);
    });
  });
});
