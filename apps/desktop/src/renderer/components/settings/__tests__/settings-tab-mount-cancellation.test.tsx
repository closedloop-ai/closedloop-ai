import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { StrictMode } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { type Deferred, deferred } from "../../../../../test/deferred.js";
import { SyncObservabilityTier } from "../../../../shared/contracts";
import { DataSyncTab } from "../data-sync-tab";
import { RelayGatewayTab } from "../relay-gateway-tab";
import { type ApiKeyStatusView, SecurityTab } from "../security-tab";

/**
 * ISS-7594 — each Settings tab's mount-time IPC reads publish only into a LIVE
 * effect: a settlement arriving after that effect was cleaned up is dropped.
 *
 * This pins convention conformance, not a defect repair. The three blocks were
 * split out of the legacy desktop Settings panel without the `cancelled` flag
 * the rest of the renderer carries (hooks/use-session-limits.ts), and these
 * cases are what stop the next split from being born without it too.
 *
 * `<StrictMode>` is the vehicle, not the claim: its effect → cleanup → effect
 * replay is development-only, but it makes a cleaned-up effect's in-flight read
 * reproducible without racing a real unmount. Cases over a published VALUE
 * settle the superseded read LAST and assert the live effect's value survived.
 * The one case over `initialized` inverts that order deliberately — a flag that
 * only ever goes true is observable solely while the live reads are still
 * pending, so its superseded settlement has to come FIRST. Either way, deleting
 * the `cancelled` guard reddens the case that covers it.
 */

const READ_FAILURE_RE = /Couldn't read your data sync level/i;
const METADATA_OPTION_RE = /^metadata only$/i;
const FULL_TRANSCRIPTS_OPTION_RE = /^full transcripts$/i;
const RADIOGROUP_NAME_RE = /data & sync level/i;

const LIVE_TARGET = "live-compute-target";
/** The compute target a cleaned-up effect must never be able to publish. */
const SUPERSEDED_TARGET = "superseded-compute-target";
/** Every switch the relay effect's mount reads publish into. */
const RELAY_SWITCH_NAMES = [
  "Pause Incoming Commands",
  "Cloud Connection",
  "Claude Code Session Tracking",
];

const NO_KEY: ApiKeyStatusView = { hasApiKey: false, source: "none" };
/** The status a cleaned-up effect must never be able to publish. */
const SUPERSEDED_KEY: ApiKeyStatusView = {
  hasApiKey: true,
  source: "safeStorage",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
    return;
  }
  Reflect.deleteProperty(window, "desktopApi");
});

/**
 * A getter stub that hands every call a promise this suite settles by hand, in
 * call order. Under StrictMode that is two promises per mount — index 0 belongs
 * to the cleaned-up effect, index 1 to the live one.
 */
function deferredGetter<T>(pending: Deferred<T>[]): () => Promise<T> {
  return vi.fn(() => {
    const next = deferred<T>();
    pending.push(next);
    return next.promise;
  });
}

/**
 * The union of the three tabs' mount-time reads. Every getter resolves by
 * default so a suite overriding one getter is not left waiting on the others.
 */
function installDesktopApi(overrides: Record<string, unknown> = {}): void {
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getDataSyncLevel: vi.fn(async () => ({ level: DataSyncLevel.Metadata })),
      getSyncConsentRecord: vi.fn(async () => ({
        bound: false,
        organizationId: null,
        tier: SyncObservabilityTier.Metadata,
      })),
      getDangerousAutoApprove: vi.fn(async () => false),
      getApiKeyStatus: vi.fn(async () => NO_KEY),
      getSettings: vi.fn(async () => ({})),
      getRuntimeStatus: vi.fn(async () => ({})),
      getCloudCommandsPaused: vi.fn(async () => false),
      getCloudConnectionEnabled: vi.fn(async () => false),
      getAgentMonitorHooksEnabled: vi.fn(async () => false),
      ...overrides,
    },
  });
}

/** Settles a hand-held promise and lets the resulting state updates flush. */
async function settle(run: () => void): Promise<void> {
  await act(async () => {
    run();
    await Promise.resolve();
  });
}

function switchNamed(name: string): HTMLElement {
  return screen.getByRole("switch", { name });
}

describe("Settings tabs — mount reads settle only into a live effect", () => {
  it("DataSyncTab keeps the live level when the cleaned-up read resolves later", async () => {
    const pending: Deferred<{ level: DataSyncLevel }>[] = [];
    installDesktopApi({ getDataSyncLevel: deferredGetter(pending) });

    render(<DataSyncTab />, { wrapper: StrictMode });
    // Asserted, not assumed: if StrictMode's double-invoke ever stops, this
    // suite must fail loudly rather than quietly stop covering the guard. The
    // reads start a microtask after mount.
    await waitFor(() => expect(pending).toHaveLength(2));

    await settle(() => pending[1].resolve({ level: DataSyncLevel.Metadata }));
    await waitFor(() =>
      expect(
        screen.getByRole("radiogroup", { name: RADIOGROUP_NAME_RE })
      ).toBeDefined()
    );
    expect(
      screen
        .getByRole("radio", { name: METADATA_OPTION_RE })
        .getAttribute("aria-checked")
    ).toBe("true");

    await settle(() => pending[0].resolve({ level: DataSyncLevel.Full }));

    // The guard is what keeps a dead read from moving a privacy control to a
    // MORE exposed level than the live read chose.
    expect(
      screen
        .getByRole("radio", { name: METADATA_OPTION_RE })
        .getAttribute("aria-checked")
    ).toBe("true");
    expect(
      screen
        .getByRole("radio", { name: FULL_TRANSCRIPTS_OPTION_RE })
        .getAttribute("aria-checked")
    ).toBe("false");
  });

  it("DataSyncTab does not raise the read-failure alert when the cleaned-up read rejects later", async () => {
    const pending: Deferred<{ level: DataSyncLevel }>[] = [];
    installDesktopApi({ getDataSyncLevel: deferredGetter(pending) });

    render(<DataSyncTab />, { wrapper: StrictMode });
    await waitFor(() => expect(pending).toHaveLength(2));

    await settle(() => pending[1].resolve({ level: DataSyncLevel.Metadata }));
    await waitFor(() =>
      expect(
        screen.getByRole("radiogroup", { name: RADIOGROUP_NAME_RE })
      ).toBeDefined()
    );

    await settle(() => pending[0].reject(new Error("ipc handler unavailable")));

    // `loadFailed` replaces the whole picker with the alert, so an unguarded
    // rejection would not merely add a banner — it would take the control away.
    // That makes this the sharpest of the four assertions.
    expect(screen.queryByText(READ_FAILURE_RE)).toBeNull();
    expect(
      screen.getByRole("radiogroup", { name: RADIOGROUP_NAME_RE })
    ).toBeDefined();
  });

  it("SecurityTab keeps the live auto-approve value and key label when cleaned-up reads resolve later", async () => {
    const dangerous: Deferred<boolean>[] = [];
    const apiKey: Deferred<ApiKeyStatusView>[] = [];
    installDesktopApi({
      getDangerousAutoApprove: deferredGetter(dangerous),
      getApiKeyStatus: deferredGetter(apiKey),
    });

    render(<SecurityTab onSettingsChange={vi.fn()} settings={{}} />, {
      wrapper: StrictMode,
    });
    expect(dangerous).toHaveLength(2);
    expect(apiKey).toHaveLength(2);

    await settle(() => {
      dangerous[1].resolve(false);
      apiKey[1].resolve(NO_KEY);
    });
    await waitFor(() =>
      expect(screen.getByText("Not configured")).toBeDefined()
    );
    expect(
      switchNamed("Dangerous Auto-Approve").getAttribute("aria-checked")
    ).toBe("false");

    await settle(() => {
      dangerous[0].resolve(true);
      apiKey[0].resolve(SUPERSEDED_KEY);
    });

    // Neither a destructive auto-approve switch raised by a dead read nor a
    // "key configured" label the live read contradicts can reach the screen
    // through a cleaned-up effect.
    expect(
      switchNamed("Dangerous Auto-Approve").getAttribute("aria-checked")
    ).toBe("false");
    expect(screen.getByText("Not configured")).toBeDefined();
  });

  it("RelayGatewayTab keeps every live mount value when the cleaned-up reads resolve later", async () => {
    const runtime: Deferred<Record<string, unknown>>[] = [];
    const paused: Deferred<boolean>[] = [];
    const connection: Deferred<boolean>[] = [];
    const hooks: Deferred<boolean>[] = [];
    installDesktopApi({
      getRuntimeStatus: deferredGetter(runtime),
      getCloudCommandsPaused: deferredGetter(paused),
      getCloudConnectionEnabled: deferredGetter(connection),
      getAgentMonitorHooksEnabled: deferredGetter(hooks),
    });

    render(
      <RelayGatewayTab
        active={false}
        onSettingsChange={vi.fn()}
        settings={{}}
      />,
      { wrapper: StrictMode }
    );
    // This effect publishes through FOUR independent writes, each with its own
    // guard. Superseding only one of them would leave the other three free to
    // lose their guard with this case still green.
    for (const pending of [runtime, paused, connection, hooks]) {
      expect(pending).toHaveLength(2);
    }

    await settle(() => {
      runtime[1].resolve({ targetId: LIVE_TARGET });
      paused[1].resolve(false);
      connection[1].resolve(false);
      hooks[1].resolve(false);
    });
    await waitFor(() =>
      expect(
        (switchNamed("Cloud Connection") as HTMLButtonElement).disabled
      ).toBe(false)
    );
    expect(screen.getByText(LIVE_TARGET)).toBeDefined();
    for (const name of RELAY_SWITCH_NAMES) {
      expect(switchNamed(name).getAttribute("aria-checked")).toBe("false");
    }

    await settle(() => {
      runtime[0].resolve({ targetId: SUPERSEDED_TARGET });
      paused[0].resolve(true);
      connection[0].resolve(true);
      hooks[0].resolve(true);
    });

    // Nobody toggled anything here, so `userToggled` is false throughout and
    // this case isolates the NEW cleanup guard from the existing one — the two
    // compose rather than one standing in for the other.
    expect(screen.getByText(LIVE_TARGET)).toBeDefined();
    expect(screen.queryByText(SUPERSEDED_TARGET)).toBeNull();
    for (const name of RELAY_SWITCH_NAMES) {
      expect(switchNamed(name).getAttribute("aria-checked")).toBe("false");
    }
  });

  it("RelayGatewayTab does not enable its switches when only the cleaned-up reads settle", async () => {
    const paused: Deferred<boolean>[] = [];
    const connection: Deferred<boolean>[] = [];
    const hooks: Deferred<boolean>[] = [];
    installDesktopApi({
      getCloudCommandsPaused: deferredGetter(paused),
      getCloudConnectionEnabled: deferredGetter(connection),
      getAgentMonitorHooksEnabled: deferredGetter(hooks),
    });

    render(
      <RelayGatewayTab
        active={false}
        onSettingsChange={vi.fn()}
        settings={{}}
      />,
      { wrapper: StrictMode }
    );

    // `initialized` is the fifth write, and the only one that is not a value:
    // it gates the three switches, never goes back to false, and so is visible
    // only BEFORE the live reads land. Hence the inverted order — settling the
    // superseded reads last, as the other cases do, could not observe it.
    await settle(() => {
      paused[0].resolve(true);
      connection[0].resolve(true);
      hooks[0].resolve(true);
    });
    for (const name of RELAY_SWITCH_NAMES) {
      expect((switchNamed(name) as HTMLButtonElement).disabled).toBe(true);
    }

    await settle(() => {
      paused[1].resolve(false);
      connection[1].resolve(false);
      hooks[1].resolve(false);
    });
    await waitFor(() =>
      expect(
        (switchNamed("Cloud Connection") as HTMLButtonElement).disabled
      ).toBe(false)
    );
  });
});
