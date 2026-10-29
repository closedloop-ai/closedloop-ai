import { DataSyncLevel } from "@repo/api/src/types/data-sync-level";
import {
  SettingsLocalDeviceReason,
  type SettingsLocalSyncPolicyProjection,
  settingsLocalDeviceUnavailable,
  settingsLocalSyncPolicyError,
  settingsLocalSyncPolicyReady,
  settingsLocalSyncPolicyUnavailable,
} from "@repo/api/src/types/settings-host-capabilities";
import { SettingsPanelHost } from "@repo/api/src/types/settings-panel";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";
import { describe, expect, it, vi } from "vitest";
import { SettingsHostAdapterProvider } from "../provider";
import {
  type SettingsHostAdapter,
  type SettingsLocalSyncPolicyCapability,
  webSettingsHostAdapter,
} from "../settings-host-adapter";
import { useLocalSyncPolicy } from "../use-local-sync-policy";

// PLN-1915 D6. `supported` is the capability's PRESENCE, and a write reports
// the projection the HOST answered with rather than the level that was asked
// for — `applyDataSyncLevel` reconciles a level down when the derived
// connectivity flags disagree, so echoing the request would show a posture the
// machine is not on.

function renderPolicy(adapter: SettingsHostAdapter) {
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsHostAdapterProvider adapter={adapter}>
      {children}
    </SettingsHostAdapterProvider>
  );
  return renderHook(() => useLocalSyncPolicy(), { wrapper });
}

/**
 * Renders the hook under a host that can be swapped in place, which is what a
 * `DesktopAppCoreMode` flip does to the real adapter.
 */
function renderSwappablePolicy(initial: SettingsHostAdapter) {
  let adapter = initial;
  const wrapper = ({ children }: { children: ReactNode }) => (
    <SettingsHostAdapterProvider adapter={adapter}>
      {children}
    </SettingsHostAdapterProvider>
  );
  const view = renderHook(() => useLocalSyncPolicy(), { wrapper });
  return {
    result: view.result,
    swapHost: (next: SettingsHostAdapter) => {
      adapter = next;
      view.rerender();
    },
  };
}

/** A host that carries the capability, like the desktop adapter always does. */
function hostWith(
  localSyncPolicy: SettingsLocalSyncPolicyCapability
): SettingsHostAdapter {
  return {
    host: SettingsPanelHost.Desktop,
    localSyncPolicy,
    readLocalDevice: () =>
      Promise.resolve(
        settingsLocalDeviceUnavailable(
          SettingsLocalDeviceReason.BridgeUnavailable
        )
      ),
  };
}

describe("useLocalSyncPolicy", () => {
  it("reports unsupported on a host with no sync-policy capability, and its write is inert", async () => {
    const { result } = renderPolicy(webSettingsHostAdapter);

    expect(result.current.supported).toBe(false);

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });

    // Nothing to settle and nothing in flight: an absent capability is not a
    // read that has not landed, so the surface must not be told a write began.
    await waitFor(() => expect(result.current.isWriting).toBe(false));
    expect(result.current.state.status).toBe("pending");
    expect(result.current.writeOutcome).toBeNull();
  });

  it("surfaces the level a ready read answered with", async () => {
    const read = vi.fn(() =>
      Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Metadata))
    );
    const { result } = renderPolicy(
      hostWith({
        read,
        write: (level) => Promise.resolve(settingsLocalSyncPolicyReady(level)),
      })
    );

    expect(result.current.supported).toBe(true);
    await waitFor(() =>
      expect(result.current.state).toEqual({
        status: "settled",
        projection: settingsLocalSyncPolicyReady(DataSyncLevel.Metadata),
      })
    );
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("settles on the level the host reconciled to, not the level that was asked for", async () => {
    const write = vi.fn(() =>
      Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Metadata))
    );
    const { result } = renderPolicy(
      hostWith({
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write,
      })
    );

    await waitFor(() => expect(result.current.state.status).toBe("settled"));

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });

    await waitFor(() => expect(result.current.writeOutcome).not.toBeNull());
    // The request went through as asked...
    expect(write).toHaveBeenCalledWith(DataSyncLevel.Full);
    // ...and the state follows the host's answer, which is neither the level
    // requested (full) nor the one previously read (off).
    const reconciled = settingsLocalSyncPolicyReady(DataSyncLevel.Metadata);
    expect(result.current.writeOutcome).toEqual(reconciled);
    expect(result.current.state).toEqual({
      status: "settled",
      projection: reconciled,
    });
    expect(result.current.isWriting).toBe(false);
  });

  it("records an unavailable write and does not claim the requested level took", async () => {
    const unavailable = settingsLocalSyncPolicyUnavailable(
      SettingsLocalDeviceReason.BridgeUnavailable
    );
    const { result } = renderPolicy(
      hostWith({
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write: () => Promise.resolve(unavailable),
      })
    );

    await waitFor(() => expect(result.current.state.status).toBe("settled"));

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });

    await waitFor(() =>
      expect(result.current.writeOutcome).toEqual(unavailable)
    );
    // The refusal carries no `level`, so no selector can read the requested
    // level back out of it. It is reported through `writeOutcome` and NOT
    // promoted into the read state (behavior change, whitlockk #6767): the read
    // state is what decides whether the picker renders at all, so promoting a
    // refusal there would replace the control with a message and leave the user
    // no way to try again. The level actually in force stays on screen.
    expect(result.current.state).toEqual({
      status: "settled",
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Off),
    });
    expect(result.current.isWriting).toBe(false);
  });

  it("settles on the level last REQUESTED, not the answer that lands last", async () => {
    // Two selections in flight at once, resolving out of order. Applying the
    // earlier answer would leave the picker and the confirmation both reporting
    // a data-egress level the user did not choose, with nothing surfaced.
    const gates = new Map<DataSyncLevel, () => void>();
    const write = vi.fn(
      (level: DataSyncLevel) =>
        new Promise<SettingsLocalSyncPolicyProjection>((resolve) => {
          gates.set(level, () => resolve(settingsLocalSyncPolicyReady(level)));
        })
    );
    const { result } = renderPolicy(
      hostWith({
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write,
      })
    );
    await waitFor(() => expect(result.current.state.status).toBe("settled"));

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });
    act(() => {
      result.current.write(DataSyncLevel.Metadata);
    });
    await act(async () => {
      gates.get(DataSyncLevel.Metadata)?.();
      await Promise.resolve();
      // The FIRST request answers LAST — the whole point of the case.
      gates.get(DataSyncLevel.Full)?.();
      await Promise.resolve();
    });

    const chosen = settingsLocalSyncPolicyReady(DataSyncLevel.Metadata);
    expect(result.current.writeOutcome).toEqual(chosen);
    expect(result.current.state).toEqual({
      status: "settled",
      projection: chosen,
    });
    expect(result.current.isWriting).toBe(false);
  });

  it("records a failed write and does not claim the requested level took", async () => {
    const failed = settingsLocalSyncPolicyError(
      SettingsLocalDeviceReason.ReadFailed
    );
    const { result } = renderPolicy(
      hostWith({
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write: () => Promise.resolve(failed),
      })
    );

    await waitFor(() => expect(result.current.state.status).toBe("settled"));

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });

    await waitFor(() => expect(result.current.writeOutcome).toEqual(failed));
    // Behavior change (whitlockk #6767): the failure is reported BESIDE the last
    // good read rather than replacing it. A transient IPC failure used to take
    // the picker off screen with no retry and no re-read, so the panel stayed
    // unusable until it remounted.
    expect(result.current.state).toEqual({
      status: "settled",
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Off),
    });
    expect(result.current.isWriting).toBe(false);
  });

  it("treats a REJECTED host call as a failed write instead of latching the lock", async () => {
    // Both shipped adapters settle rather than reject, and that is the stated
    // contract — but the type is a plain `Promise`, and an adapter that broke it
    // would strand `isWriting` true with the picker disabled for the rest of the
    // session.
    const { result } = renderPolicy(
      hostWith({
        read: () =>
          Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
        write: () => Promise.reject(new Error("bridge exploded")),
      })
    );

    await waitFor(() => expect(result.current.state.status).toBe("settled"));

    act(() => {
      result.current.write(DataSyncLevel.Full);
    });

    await waitFor(() =>
      expect(result.current.writeOutcome).toEqual(
        settingsLocalSyncPolicyError(SettingsLocalDeviceReason.ReadFailed)
      )
    );
    expect(result.current.isWriting).toBe(false);
    expect(result.current.state).toEqual({
      status: "settled",
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Off),
    });
  });

  it("drops a write issued against the host that was just replaced", async () => {
    // On desktop a `DesktopAppCoreMode` flip rebuilds the whole stack including
    // this adapter. A write already in flight against the old host answers for a
    // machine posture the new host was never asked about, and it settles AFTER
    // the new host's read — so without a generation bump in the read effect it
    // lands last and wins.
    const gates = new Map<DataSyncLevel, () => void>();
    const firstHost = hostWith({
      read: () =>
        Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Off)),
      write: (level: DataSyncLevel) =>
        new Promise<SettingsLocalSyncPolicyProjection>((resolve) => {
          gates.set(level, () => resolve(settingsLocalSyncPolicyReady(level)));
        }),
    });
    const secondHost = hostWith({
      read: () =>
        Promise.resolve(settingsLocalSyncPolicyReady(DataSyncLevel.Metadata)),
      write: (level: DataSyncLevel) =>
        Promise.resolve(settingsLocalSyncPolicyReady(level)),
    });
    const view = renderSwappablePolicy(firstHost);
    await waitFor(() =>
      expect(view.result.current.state.status).toBe("settled")
    );

    act(() => {
      view.result.current.write(DataSyncLevel.Full);
    });
    expect(view.result.current.isWriting).toBe(true);

    act(() => {
      view.swapHost(secondHost);
    });
    const onSecondHost = {
      status: "settled",
      projection: settingsLocalSyncPolicyReady(DataSyncLevel.Metadata),
    };
    await waitFor(() =>
      expect(view.result.current.state).toEqual(onSecondHost)
    );
    // Released by the swap, not by the retired write — which never reaches its
    // own release, so without this the picker is locked for good.
    expect(view.result.current.isWriting).toBe(false);

    await act(async () => {
      gates.get(DataSyncLevel.Full)?.();
      await Promise.resolve();
    });

    expect(view.result.current.state).toEqual(onSecondHost);
    expect(view.result.current.writeOutcome).toBeNull();
    expect(view.result.current.isWriting).toBe(false);
  });
});
