import { act, render, screen, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopSyncPrompt } from "../components/desktop-sync-prompt";
import { DesktopAuthProvider } from "../shared-agent-sessions/desktop-auth-provider";
import type {
  DesktopAuthState,
  DesktopExistingUserResolution,
} from "../types/desktop-api";

const PROMPT_TEXT = /Sign in with GitHub to sync/i;
const DISMISS_LABEL = /Not now/i;
const SIGN_IN_LABEL = /Sign in with GitHub/i;

const SIGNED_OUT: DesktopAuthState = {
  status: "signed_out",
  userId: null,
  organizationId: null,
};

const PROMPT_RESOLUTION: DesktopExistingUserResolution = {
  kind: "prompt",
  dismissed: false,
};

const NONE_RESOLUTION: DesktopExistingUserResolution = {
  kind: "none",
  dismissed: false,
};

type ResolutionListener = (r: DesktopExistingUserResolution) => void;

function setupDesktopApi(resolution: DesktopExistingUserResolution) {
  const listeners = new Set<ResolutionListener>();
  const api = {
    // Browser sign-in is always available (FEA-4133) and the unified onboarding
    // flow is always-on (FEA-3999), so the prompt's only gate is main's
    // resolution state.
    getSettings: vi.fn(() => Promise.resolve({})),
    // Auth bridge (used by useDesktopAuth inside the prompt).
    getDesktopAuthState: vi.fn(() => Promise.resolve(SIGNED_OUT)),
    onDesktopAuthStateChanged: vi.fn(() => () => undefined),
    beginDesktopSignIn: vi.fn(() => Promise.resolve({ ok: true as const })),
    cancelDesktopSignIn: vi.fn(() => Promise.resolve()),
    signOutDesktop: vi.fn(() => Promise.resolve()),
    // Existing-user bridge.
    getExistingUserResolution: vi.fn(() => Promise.resolve(resolution)),
    dismissExistingUserPrompt: vi.fn(() => Promise.resolve()),
    onExistingUserResolutionChanged: vi.fn((cb: ResolutionListener) => {
      listeners.add(cb);
      return () => {
        listeners.delete(cb);
      };
    }),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: api,
  });
  return {
    api,
    push: (next: DesktopExistingUserResolution) => {
      for (const cb of listeners) {
        cb(next);
      }
    },
  };
}

function renderPrompt(): ReactNode {
  return (
    <DesktopAuthProvider>
      <DesktopSyncPrompt />
    </DesktopAuthProvider>
  );
}

describe("DesktopSyncPrompt", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("shows the one-time prompt when resolution is prompt", async () => {
    setupDesktopApi(PROMPT_RESOLUTION);
    render(renderPrompt());
    // findByText throws if the prompt never renders.
    expect(await screen.findByText(PROMPT_TEXT)).toBeTruthy();
  });

  it("renders nothing when resolution is none", async () => {
    const { api } = setupDesktopApi(NONE_RESOLUTION);
    render(renderPrompt());
    await waitFor(() =>
      expect(api.getExistingUserResolution).toHaveBeenCalled()
    );
    expect(screen.queryByText(PROMPT_TEXT)).toBeNull();
  });

  it("dismiss persists and never hard-blocks: prompt clears on the pushed none", async () => {
    const { api, push } = setupDesktopApi(PROMPT_RESOLUTION);
    render(renderPrompt());
    const dismiss = await screen.findByRole("button", { name: DISMISS_LABEL });

    act(() => {
      dismiss.click();
    });
    expect(api.dismissExistingUserPrompt).toHaveBeenCalledTimes(1);

    // Main pushes the settled `none` after persisting; the prompt disappears.
    act(() => {
      push({ kind: "none", dismissed: true });
    });
    await waitFor(() => expect(screen.queryByText(PROMPT_TEXT)).toBeNull());
  });

  it("sign-in reuses the browser OAuth flow via the auth bridge", async () => {
    const { api } = setupDesktopApi(PROMPT_RESOLUTION);
    render(renderPrompt());
    const signIn = await screen.findByRole("button", {
      name: SIGN_IN_LABEL,
    });

    act(() => {
      signIn.click();
    });
    await waitFor(() =>
      expect(api.beginDesktopSignIn).toHaveBeenCalledTimes(1)
    );
  });
});
