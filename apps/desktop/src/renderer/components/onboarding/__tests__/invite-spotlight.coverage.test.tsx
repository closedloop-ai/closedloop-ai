/**
 * Three branches `invite-spotlight.test.tsx` does not reach:
 * - `answer()`'s own `if (organizationId === null) return;` (L224) — every
 *   case in the main suite answers with a real org id.
 * - `onOpenChange`'s `if (!next) { answer(); }` (L245) — only the `next=false`
 *   (close/dismiss) arm is exercised there; `next=true` never runs `answer()`.
 * - The `InviteTeamDialog`'s own `onOpenChange={(next) => setInviteOpenFor(next
 *   ? identityKey : null)}` (L272) — the main suite only ever opens the dialog
 *   through `spotlight.onInvite`, never through the dialog's own close/reopen
 *   callback.
 *
 * `InviteTeamDialog` is mocked to a marker that exposes its `onOpenChange`
 * directly, and a bare consumer of `useInviteSpotlight` stands in for the
 * sidebar/topbar hosts — neither is needed to observe these three branches.
 */

import { SidebarProvider } from "@closedloop-ai/design-system/components/ui/sidebar";
import { FeatureFlagAdapterProvider } from "@repo/app/shared/feature-flags/provider";
import { createStaticFeatureFlagAdapter } from "@repo/app/shared/feature-flags/static-feature-flag-adapter";
import { act, render, screen } from "@testing-library/react";
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { DesktopAuthStatus } from "../../../../shared/contracts";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import { stubLocalStorage } from "../../../__tests__/local-storage-stub";
import { DesktopAppCoreProvider } from "../../../shared-agent-sessions/desktop-app-core-provider";
import { resetDesktopIdentityCacheForTests } from "../../../shared-agent-sessions/use-desktop-identity";
import { inviteSpotlightDismissedStorageKey } from "../../dashboard/dashboard-storage-keys";
import {
  InviteSpotlightProvider,
  useInviteSpotlight,
} from "../invite-spotlight";

const ORG_ID = "org_acme";
const USER_ID = "user_1";

const CONSENTED: SyncConsentRecord = {
  bound: true,
  organizationId: ORG_ID,
  tier: "metadata",
};

type DialogProps = {
  onOpenChange: (next: boolean) => void;
  open: boolean;
};

let latestDialogProps: DialogProps | undefined;

vi.mock("@repo/app/organizations/components/invite-team-dialog", () => ({
  InviteTeamDialog: (props: DialogProps) => {
    latestDialogProps = props;
    return <div data-open={String(props.open)} data-testid="invite-dialog" />;
  },
}));

const bridge = {
  getDesktopAuthState: vi.fn(),
  getDesktopIdentity: vi.fn(),
  getSyncConsentRecord: vi.fn(),
  onDesktopAuthStateChanged: vi.fn(),
};

function stubBridge() {
  bridge.getDesktopAuthState = vi.fn(() =>
    Promise.resolve({
      organizationId: ORG_ID,
      status: DesktopAuthStatus.Authenticated,
      userId: USER_ID,
    })
  );
  bridge.getDesktopIdentity = vi.fn(() =>
    Promise.resolve({
      organizationName: "Closedloop",
      userName: "Ada Lovelace",
      email: "ada@closedloop.ai",
    })
  );
  bridge.getSyncConsentRecord = vi.fn(() => Promise.resolve(CONSENTED));
  bridge.onDesktopAuthStateChanged = vi.fn(() => () => {
    // no-op unsubscribe
  });
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: bridge,
    writable: true,
  });
}

function Consumer() {
  const spotlight = useInviteSpotlight();
  return (
    <div>
      <span data-testid="dismissed">
        {String(
          localStorage.getItem(inviteSpotlightDismissedStorageKey(ORG_ID))
        )}
      </span>
      <button onClick={() => spotlight.onOpenChange(true)} type="button">
        open-true
      </button>
      <button onClick={() => spotlight.onOpenChange(false)} type="button">
        open-false
      </button>
    </div>
  );
}

function renderProvider() {
  return render(
    <DesktopAppCoreProvider>
      <FeatureFlagAdapterProvider
        adapter={createStaticFeatureFlagAdapter({ enabledFlags: [] })}
      >
        <SidebarProvider>
          <InviteSpotlightProvider>
            <Consumer />
          </InviteSpotlightProvider>
        </SidebarProvider>
      </FeatureFlagAdapterProvider>
    </DesktopAppCoreProvider>
  );
}

beforeAll(() => {
  Object.defineProperty(window, "matchMedia", {
    configurable: true,
    value: vi.fn(() => ({
      addEventListener: vi.fn(),
      addListener: vi.fn(),
      dispatchEvent: vi.fn(),
      matches: false,
      media: "",
      onchange: null,
      removeEventListener: vi.fn(),
      removeListener: vi.fn(),
    })),
  });
});

beforeEach(() => {
  resetDesktopIdentityCacheForTests();
  stubLocalStorage();
  stubBridge();
  latestDialogProps = undefined;
});

afterEach(() => {
  Reflect.deleteProperty(window, "desktopApi");
  vi.clearAllMocks();
});

describe("invite spotlight — onOpenChange(true) never spends the dismissal (L245)", () => {
  it("writes no dismissal flag when the popover reports an open, not a close", async () => {
    renderProvider();
    await screen.findByTestId("dismissed");

    act(() => {
      screen.getByRole("button", { name: "open-true" }).click();
    });

    expect(
      localStorage.getItem(inviteSpotlightDismissedStorageKey(ORG_ID))
    ).toBeNull();
  });

  it("writes the dismissal flag when the popover reports a close (the sibling arm)", async () => {
    renderProvider();
    await screen.findByTestId("dismissed");

    act(() => {
      screen.getByRole("button", { name: "open-false" }).click();
    });

    expect(
      localStorage.getItem(inviteSpotlightDismissedStorageKey(ORG_ID))
    ).toBe("1");
  });
});

describe("invite spotlight — the invite dialog's own onOpenChange (L272)", () => {
  it("tracks the dialog opening under the current identity", async () => {
    renderProvider();
    await screen.findByTestId("dismissed");

    act(() => {
      latestDialogProps?.onOpenChange(true);
    });

    expect(screen.getByTestId("invite-dialog").dataset.open).toBe("true");
  });

  it("clears the open identity when the dialog reports its own close", async () => {
    renderProvider();
    await screen.findByTestId("dismissed");

    act(() => {
      latestDialogProps?.onOpenChange(true);
    });
    expect(screen.getByTestId("invite-dialog").dataset.open).toBe("true");

    act(() => {
      latestDialogProps?.onOpenChange(false);
    });
    expect(screen.getByTestId("invite-dialog").dataset.open).toBe("false");
  });
});

describe("invite spotlight — answer() is a no-op with no organization (L224)", () => {
  it("writes nothing when the popover closes for a signed-out/guest standing", async () => {
    // No org id: `answer()`'s own early return, distinct from the withhold
    // arm in `shouldShowInviteSpotlight` — the nudge is not showing here
    // either way, but this pins that closing it writes nothing rather than a
    // dismissal keyed on `null`.
    bridge.getDesktopAuthState = vi.fn(() =>
      Promise.resolve({
        organizationId: null,
        status: DesktopAuthStatus.Authenticated,
        userId: USER_ID,
      })
    );
    renderProvider();
    await screen.findByTestId("dismissed");

    act(() => {
      screen.getByRole("button", { name: "open-false" }).click();
    });

    expect(
      localStorage.getItem(inviteSpotlightDismissedStorageKey("null"))
    ).toBeNull();
  });
});
