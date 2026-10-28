import { useFeatureFlag } from "@repo/analytics/client";
import { DEV_MODE_FLAG_KEY } from "@repo/api/src/types/dev-mode-flag";
import { FEATURE_FLAG_OVERRIDES_STORAGE_KEY } from "@repo/api/src/types/feature-flag-overrides";
import { DevToolsOverlay } from "@repo/app/shared/dev-tools/components/dev-tools-overlay";
import {
  DEV_TOOLS_LABEL,
  DEV_TOOLS_SETTING_LABELS,
} from "@repo/app/shared/dev-tools/lib/dev-tools-copy";
import { DevToolsSetting } from "@repo/app/shared/dev-tools/lib/dev-tools-settings";
import {
  DEV_MODE_CONTROL_LABEL,
  DEV_MODE_STORAGE_KEY,
} from "@repo/app/shared/feature-flags/dev-mode/dev-mode-contract";
import { DevModeSidebarItem } from "@repo/app/shared/feature-flags/dev-mode/dev-mode-sidebar-item";
import { useFeatureFlagEnabled } from "@repo/app/shared/feature-flags/use-feature-flag-enabled";
import { SESSION_TRACE_TAB_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { cleanup, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { renderToString } from "react-dom/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { AppCoreAdapterProvider } from "@/lib/app-core-adapters";

const mockUseUser = vi.fn();

vi.mock("@repo/auth/client", () => ({
  useUser: () => mockUseUser(),
  useAuth: () => ({
    isLoaded: true,
    userId: "user_1",
    orgId: "org_1",
    getToken: () => Promise.resolve("token"),
  }),
}));

/**
 * Make BOTH flag bindings in `@repo/analytics/client` answer from the same
 * fixture, so which one is live is not decided by ambient env.
 *
 * `posthogEnabled` is `!!NEXT_PUBLIC_POSTHOG_KEY` at module scope: without the
 * key, flags resolve from `readFallbackFeatureFlag` (this fixture); with it,
 * they resolve through `@posthog/next`, whose repo-wide vitest mock answers
 * `enabled: true` to EVERY key. That second path would pin the rollout flag on
 * regardless of the fixture and make the rolled-back case below unrunnable —
 * green on a laptop, red or vacuous elsewhere. The literal key is inlined
 * because a `vi.mock` factory is hoisted above this file's consts.
 */
vi.mock("@posthog/next", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  useFeatureFlag: (flag: string) => {
    const raw = globalThis.localStorage.getItem("closedloop:e2e-feature-flags");
    const fixture: Record<string, boolean> = raw ? JSON.parse(raw) : {};
    return {
      key: flag,
      enabled: fixture[flag] === true,
      variant: undefined,
      payload: undefined,
    };
  },
}));

const FALLBACK_FEATURE_FLAGS_STORAGE_KEY = "closedloop:e2e-feature-flags";
const INTERNAL_FLAG = "sessions-grid-fold-legibility";
// The `@closedloop.ai` DOMAIN is what `isStaffEmail` matches, so it is load-bearing
// here; the local part is not, and must not name a real employee.
const STAFF_EMAIL = "ada@closedloop.ai";
const CUSTOMER_EMAIL = "dana@acme-corp.com";
const RESOLVED_EXACTLY = /^resolved$/;

afterEach(() => {
  cleanup();
  localStorage.removeItem(DEV_MODE_STORAGE_KEY);
  localStorage.removeItem(FALLBACK_FEATURE_FLAGS_STORAGE_KEY);
  localStorage.removeItem(FEATURE_FLAG_OVERRIDES_STORAGE_KEY);
  mockUseUser.mockReset();
});

/**
 * ISS-7477. These mount the REAL composition root, so they fail if
 * `WebDevModeProvider` is ever dropped from `AppCoreAdapterProvider` — not just
 * if the provider itself regresses.
 *
 * The flag is pinned ENABLED from both directions (the `@posthog/next` bundler
 * mock always answers `enabled: true`; the fixture below covers a build with no
 * PostHog key), so every "suppressed" assertion here would read `true` if the
 * suppression were removed. A test that only passed because the flag was off
 * anyway would prove nothing.
 */
describe("dev mode in the web composition root", () => {
  it("renders the dev mode row only after mount, so the server and hydration renders agree (ISS-12135 bug 59)", () => {
    // An identity known on both sides (local-trusted) and a flag the browser
    // already holds: before the fix the server-side string carried the row the
    // real server could not, because only the browser has the flag.
    signIn(STAFF_EMAIL);
    pinFlags();
    const tree = (
      <AppCoreAdapterProvider>
        <ul>
          <DevModeSidebarItem />
        </ul>
      </AppCoreAdapterProvider>
    );

    expect(renderToString(tree)).not.toContain(DEV_MODE_CONTROL_LABEL);

    render(tree);
    expect(screen.getByText(DEV_MODE_CONTROL_LABEL)).toBeInTheDocument();
  });

  it("renders the Dev Tools overlay only after mount, for the same reason (ISS-12135 bug 59)", () => {
    signIn(STAFF_EMAIL);
    pinFlags();
    const tree = (
      <AppCoreAdapterProvider>
        <DevToolsOverlay />
      </AppCoreAdapterProvider>
    );

    expect(renderToString(tree)).not.toContain(DEV_TOOLS_LABEL);

    render(tree);
    expect(
      screen.getByRole("button", { name: DEV_TOOLS_LABEL })
    ).toBeInTheDocument();
  });

  it("suppresses an enabled flag for an internal viewer who left dev mode", () => {
    signIn(STAFF_EMAIL);
    leaveDevMode();

    renderWithComposition();

    expect(screen.getByTestId("port-flag")).toHaveTextContent("off");
    expect(screen.getByTestId("direct-flag")).toHaveTextContent("off");
  });

  it("leaves that same flag enabled for the same viewer while in dev mode", () => {
    signIn(STAFF_EMAIL);

    renderWithComposition();

    expect(screen.getByTestId("port-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("direct-flag")).toHaveTextContent("on");
  });

  it("never suppresses for a CUSTOMER, even with the stored key set to off", () => {
    signIn(CUSTOMER_EMAIL);
    leaveDevMode();

    renderWithComposition();

    // Identical stored state to the first test; only the email differs. The two
    // identity branches therefore fail independently of each other.
    expect(screen.getByTestId("port-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("direct-flag")).toHaveTextContent("on");
  });

  it("keeps the dev-mode flag itself resolving while the rest is suppressed", () => {
    signIn(STAFF_EMAIL);
    leaveDevMode();

    renderWithComposition();

    // The escape hatch, asserted on the PRODUCTION wiring rather than on a
    // test-local exempt list. `DevModeSidebarItem` gates itself on this exact flag,
    // so if `exemptFlagKeys` is ever dropped from `WebDevModeProvider` the
    // control that turns the customer view OFF disappears the moment it is
    // turned ON, and the viewer has no way back.
    expect(screen.getByTestId("escape-hatch-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("port-flag")).toHaveTextContent("off");
  });

  it("releases a stored customer view when the rollout is rolled BACK", () => {
    signIn(STAFF_EMAIL);
    leaveDevMode();

    renderWithComposition({ rolloutEnabled: false });

    // The reported trap, driven through the real composition root: the rollout
    // gate un-renders the switch, so a stored `false` that still suppressed here
    // would leave this viewer with every non-exempt flag forced off and no
    // control to restore them — recoverable only by clearing localStorage by
    // hand. Same identity and same stored key as the first test, which reads
    // `off`; only the rollout verdict differs.
    expect(screen.getByTestId("port-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("direct-flag")).toHaveTextContent("on");
    // And the gate really is off — so this is the hidden-control state, not a
    // case where the flag happened to stay on.
    expect(screen.getByTestId("escape-hatch-flag")).toHaveTextContent("off");
  });

  it("applies a stored customer-view choice before identity has resolved", () => {
    mockUseUser.mockReturnValue({ isLoaded: false, user: undefined });
    leaveDevMode();

    renderWithComposition();

    // "Identity not known yet" must not read as "not internal". Folding the two
    // together shows the INTERNAL view for the first frames of every load — to
    // exactly the viewer who asked for the customer one — because PostHog
    // bootstraps flags from a cookie and can answer before Clerk does.
    expect(screen.getByTestId("port-flag")).toHaveTextContent("off");
  });

  it("reports a suppressed flag as RESOLVED, not still loading", () => {
    signIn(STAFF_EMAIL);
    leaveDevMode();

    renderWithComposition();

    // FEA-1626: a data-read surface gates its request on resolution. Reporting
    // "unresolved" here would leave every gated read waiting on a value that is
    // never coming.
    // Anchored: `toHaveTextContent` matches a SUBSTRING, and "unresolved"
    // contains "resolved" — the unanchored form passed against the exact
    // regression it is here to catch.
    expect(screen.getByTestId("direct-resolved")).toHaveTextContent(
      RESOLVED_EXACTLY
    );
  });
});

/**
 * ISS-12048. The Dev Tools overlay writes an override through `@repo/app`, and
 * the flag read path in `@repo/analytics` honors it, only because
 * `WebDevModeProvider` mounts the overrides provider from Dev Mode. These drive
 * that whole path through the real composition root, for both the port reader
 * and the direct `useFeatureFlag` reader.
 */
describe("Dev Tools flag overrides in the web composition root", () => {
  it("lets the overlay force a PostHog-enabled flag off while Dev Mode is on", async () => {
    signIn(STAFF_EMAIL);
    renderOverrideComposition();
    expect(screen.getByTestId("override-port-flag")).toHaveTextContent("on");

    const user = userEvent.setup();
    await user.click(screen.getByRole("button", { name: DEV_TOOLS_LABEL }));
    const group = within(screen.getByRole("dialog")).getByRole("radiogroup", {
      name: SESSION_TRACE_TAB_FEATURE_FLAG_KEY,
    });
    await user.click(
      within(group).getByRole("radio", {
        name: DEV_TOOLS_SETTING_LABELS[DevToolsSetting.Off],
      })
    );

    expect(screen.getByTestId("override-port-flag")).toHaveTextContent("off");
    expect(screen.getByTestId("override-direct-flag")).toHaveTextContent("off");
  });

  it("ignores a stored override, and shows no overlay, for a customer", () => {
    signIn(CUSTOMER_EMAIL);
    storeOverride(false);

    renderOverrideComposition();

    expect(
      screen.queryByRole("button", { name: DEV_TOOLS_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("override-port-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("override-direct-flag")).toHaveTextContent("on");
  });

  it("ignores a stored override while the dev-mode rollout is off", () => {
    signIn(STAFF_EMAIL);
    storeOverride(false);

    renderOverrideComposition({ rolloutEnabled: false });

    expect(
      screen.queryByRole("button", { name: DEV_TOOLS_LABEL })
    ).not.toBeInTheDocument();
    expect(screen.getByTestId("override-port-flag")).toHaveTextContent("on");
  });
});

/**
 * ISS-12048: a `$vibe` preview's snapshot, handed to the composition root by
 * the root layout, pins both flag readers.
 */
describe("pinned snapshot flags in the web composition root", () => {
  it("pins a flag the fixture has off to its snapshot value", () => {
    signIn(CUSTOMER_EMAIL);
    localStorage.setItem(
      FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
      JSON.stringify({ [SESSION_TRACE_TAB_FEATURE_FLAG_KEY]: false })
    );

    render(
      <AppCoreAdapterProvider
        pinnedFeatureFlags={{ [SESSION_TRACE_TAB_FEATURE_FLAG_KEY]: true }}
      >
        <OverrideProbe />
      </AppCoreAdapterProvider>
    );

    expect(screen.getByTestId("override-port-flag")).toHaveTextContent("on");
    expect(screen.getByTestId("override-direct-flag")).toHaveTextContent("on");
  });
});

function storeOverride(enabled: boolean) {
  localStorage.setItem(
    FEATURE_FLAG_OVERRIDES_STORAGE_KEY,
    JSON.stringify({ [SESSION_TRACE_TAB_FEATURE_FLAG_KEY]: enabled })
  );
}

function OverrideProbe() {
  const viaPort = useFeatureFlagEnabled(SESSION_TRACE_TAB_FEATURE_FLAG_KEY);
  const direct = useFeatureFlag(SESSION_TRACE_TAB_FEATURE_FLAG_KEY);

  return (
    <>
      <span data-testid="override-port-flag">{viaPort ? "on" : "off"}</span>
      <span data-testid="override-direct-flag">
        {direct?.enabled ? "on" : "off"}
      </span>
    </>
  );
}

function renderOverrideComposition({ rolloutEnabled = true } = {}) {
  localStorage.setItem(
    FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
    JSON.stringify({
      [SESSION_TRACE_TAB_FEATURE_FLAG_KEY]: true,
      [DEV_MODE_FLAG_KEY]: rolloutEnabled,
    })
  );

  return render(
    <AppCoreAdapterProvider>
      <OverrideProbe />
      <DevToolsOverlay />
    </AppCoreAdapterProvider>
  );
}

function signIn(emailAddress: string) {
  mockUseUser.mockReturnValue({
    isLoaded: true,
    user: { primaryEmailAddress: { emailAddress } },
  });
}

function leaveDevMode() {
  localStorage.setItem(DEV_MODE_STORAGE_KEY, "false");
}

function FlagProbe() {
  const viaPort = useFeatureFlagEnabled(INTERNAL_FLAG);
  const direct = useFeatureFlag(INTERNAL_FLAG);
  const escapeHatch = useFeatureFlagEnabled(DEV_MODE_FLAG_KEY);

  return (
    <>
      <span data-testid="port-flag">{viaPort ? "on" : "off"}</span>
      <span data-testid="direct-flag">{direct?.enabled ? "on" : "off"}</span>
      <span data-testid="direct-resolved">
        {direct === undefined ? "unresolved" : "resolved"}
      </span>
      <span data-testid="escape-hatch-flag">{escapeHatch ? "on" : "off"}</span>
    </>
  );
}

function renderWithComposition({ rolloutEnabled = true } = {}) {
  pinFlags({ rolloutEnabled });

  return render(
    <AppCoreAdapterProvider>
      <FlagProbe />
    </AppCoreAdapterProvider>
  );
}

/**
 * The single source both flag bindings read (see the `@posthog/next` mock
 * above). `INTERNAL_FLAG` is always ON here, so every "suppressed" assertion
 * would read `on` if the suppression were removed.
 */
function pinFlags({ rolloutEnabled = true } = {}) {
  localStorage.setItem(
    FALLBACK_FEATURE_FLAGS_STORAGE_KEY,
    JSON.stringify({
      [INTERNAL_FLAG]: true,
      [DEV_MODE_FLAG_KEY]: rolloutEnabled,
    })
  );
}
