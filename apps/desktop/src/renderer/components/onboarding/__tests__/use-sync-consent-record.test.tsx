// @vitest-environment jsdom

import { act, cleanup, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { SyncConsentRecord } from "../../../../shared/sync-consent";
import {
  useDeviceSyncConsentRecord,
  useSyncConsentRecord,
} from "../use-sync-consent-record";

const ORG_ID = "org_acme";
const USER_ID = "user_1";
const STATE_PROBE = "consent-state";

const UNANSWERED: SyncConsentRecord = {
  bound: false,
  organizationId: null,
  tier: null,
};
const ANSWERED: SyncConsentRecord = {
  bound: true,
  organizationId: ORG_ID,
  tier: "full",
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

afterEach(() => {
  cleanup();
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  vi.restoreAllMocks();
});

describe("useSyncConsentRecord", () => {
  it("exposes a settled guest device answer without giving account readers consent", async () => {
    const bridge = installDesktopApi({ initial: UNANSWERED });
    function GuestProbe() {
      const device = useDeviceSyncConsentRecord();
      const account = useSyncConsentRecord(null);
      return (
        <div data-testid={STATE_PROBE}>
          {JSON.stringify({ device: device.record, account: account.record })}
        </div>
      );
    }
    render(<GuestProbe />);
    await waitFor(() =>
      expect(JSON.parse(stateText())).toEqual({
        device: UNANSWERED,
        account: null,
      })
    );
    act(() => bridge.push(ANSWERED));
    await waitFor(() =>
      expect(JSON.parse(stateText())).toEqual({
        device: ANSWERED,
        account: null,
      })
    );
    expect(bridge.getSyncConsentRecord).toHaveBeenCalledTimes(1);
  });

  it("settles a malformed pull as unreadable instead of consented", async () => {
    installDesktopApi({ initial: { tier: "full", organizationId: ORG_ID } });

    render(<ConsentProbe />);

    await waitFor(() => expect(stateText()).toBe("settled:null"));
  });

  it("accepts valid records from pull and push", async () => {
    const bridge = installDesktopApi({ initial: UNANSWERED });

    render(<ConsentProbe />);

    await waitFor(() => expect(stateText()).toBe("settled:unset|none|false"));

    act(() => {
      bridge.push(ANSWERED);
    });

    await waitFor(() =>
      expect(stateText()).toBe(`settled:full|${ORG_ID}|true`)
    );
  });

  it("settles a malformed push as unreadable instead of consented", async () => {
    const bridge = installDesktopApi({ initial: UNANSWERED });

    render(<ConsentProbe />);

    await waitFor(() => expect(stateText()).toBe("settled:unset|none|false"));

    act(() => {
      bridge.push({ tier: "full", organizationId: ORG_ID });
    });

    await waitFor(() => expect(stateText()).toBe("settled:null"));
  });
});

function ConsentProbe() {
  const { record, isResolved } = useSyncConsentRecord(USER_ID);
  const recordText =
    record === null
      ? "null"
      : `${record.tier ?? "unset"}|${record.organizationId ?? "none"}|${String(record.bound)}`;
  return (
    <div data-testid={STATE_PROBE}>
      {isResolved ? "settled" : "pending"}:{recordText}
    </div>
  );
}

function installDesktopApi({ initial }: { initial: unknown }) {
  let current = initial;
  const listeners = new Set<(next: unknown) => void>();
  const getSyncConsentRecord = vi.fn(() => Promise.resolve(current));
  const onSyncConsentRecordChanged = vi.fn(
    (callback: (next: unknown) => void) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    }
  );

  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: {
      getSyncConsentRecord,
      onSyncConsentRecordChanged,
    },
    writable: true,
  });

  return {
    getSyncConsentRecord,
    onSyncConsentRecordChanged,
    push(next: unknown) {
      current = next;
      for (const listener of listeners) {
        listener(next);
      }
    },
  };
}

function stateText(): string {
  return screen.getByTestId(STATE_PROBE).textContent ?? "";
}
