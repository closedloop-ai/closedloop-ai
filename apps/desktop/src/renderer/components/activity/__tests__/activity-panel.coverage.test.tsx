import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ActivityPanel } from "../ActivityPanel";

// Two branches `activity-panel.test.tsx` does not reach:
// - `if (cancelled.current) return;` inside `load`: a load whose sequence is
//   still current but whose component unmounted before the read settled.
// - the "Show Regular Events" checkbox's own `onCheckedChange`: only its
//   Security sibling is exercised elsewhere.

const enabledFlags = vi.hoisted(() => new Set<string>());
vi.mock("@repo/app/shared/feature-flags/use-feature-flag-enabled", () => ({
  useFeatureFlagEnabled: (key: string) => enabledFlags.has(key),
  useFeatureFlagEnabledOptional: (key: string) => enabledFlags.has(key),
}));

// A real unmount cannot prove the `cancelled.current` guard did anything —
// React already refuses to commit a setState on an unmounted tree with or
// without it. Replacing the hook with a ref we flip ourselves, while the
// component stays mounted, is the only way to observe the guard's own effect
// on rendered output.
const cancelledRefState = vi.hoisted(() => ({ current: false }));
vi.mock("../../../hooks/use-cancelled-ref", () => ({
  useCancelledRef: () => cancelledRefState,
}));

beforeEach(() => {
  enabledFlags.clear();
});

type ActivityApiMocks = {
  getActivityEvents: ReturnType<typeof vi.fn>;
  clearActivityEvents: ReturnType<typeof vi.fn>;
};

const originalDesktopApi = Object.getOwnPropertyDescriptor(
  window,
  "desktopApi"
);

function installActivityApi({
  events = [],
}: {
  events?: unknown[];
}): ActivityApiMocks {
  const mocks: ActivityApiMocks = {
    getActivityEvents: vi.fn(async () => events),
    clearActivityEvents: vi.fn(async () => undefined),
  };
  Object.defineProperty(window, "desktopApi", {
    configurable: true,
    value: mocks,
  });
  return mocks;
}

afterEach(() => {
  if (originalDesktopApi) {
    Object.defineProperty(window, "desktopApi", originalDesktopApi);
  } else {
    Reflect.deleteProperty(window, "desktopApi");
  }
  cancelledRefState.current = false;
});

const REQUEST_EVENT = {
  id: "evt-1",
  type: "request",
  timestamp: "2026-07-22T10:15:30.000Z",
  method: "POST",
  path: "/api/gateway/spawn",
  statusCode: 200,
  durationMs: 42,
};

describe("ActivityPanel — a settled load dropped once cancelled", () => {
  it("does not commit a stale read's rows once the cancelled ref is set", async () => {
    let releaseEvents: ((value: unknown[]) => void) | undefined;
    const mocks = installActivityApi({});
    mocks.getActivityEvents.mockReturnValue(
      new Promise((resolve) => {
        releaseEvents = resolve;
      })
    );
    render(<ActivityPanel />);

    // Simulate the component having torn down mid-load without actually
    // unmounting it, so the assertion below can only pass if the `load`
    // callback's own `if (cancelled.current) return;` check ran.
    cancelledRefState.current = true;
    await act(async () => {
      releaseEvents?.([REQUEST_EVENT]);
      await Promise.resolve();
      await Promise.resolve();
    });

    expect(screen.queryByText("POST")).toBeNull();
  });
});

describe("ActivityPanel — Show Regular Events filter", () => {
  it("hides a regular event, and only a regular event, when unchecked", async () => {
    installActivityApi({
      events: [
        REQUEST_EVENT,
        { ...REQUEST_EVENT, id: "evt-2", type: "security" },
      ],
    });
    render(<ActivityPanel />);

    await waitFor(() => expect(screen.getAllByText("POST")).toHaveLength(2));

    fireEvent.click(screen.getByLabelText("Show Regular Events"));

    await waitFor(() => expect(screen.getAllByText("POST")).toHaveLength(1));
  });
});

describe("ActivityPanel — blank timestamp column", () => {
  it("renders an empty timestamp cell for an event with no timestamp", async () => {
    installActivityApi({
      events: [{ ...REQUEST_EVENT, timestamp: undefined }],
    });
    render(<ActivityPanel />);

    const methodCell = await screen.findByText("POST");
    const timestampCell = methodCell.previousElementSibling;
    expect(timestampCell?.textContent).toBe("");
  });
});

describe("ActivityPanel — a null events payload", () => {
  it("renders the empty state rather than throwing when the read resolves null", async () => {
    const mocks = installActivityApi({});
    mocks.getActivityEvents.mockResolvedValue(null);
    render(<ActivityPanel />);

    await waitFor(() =>
      expect(screen.getByText("No gateway requests yet")).toBeTruthy()
    );
  });
});
