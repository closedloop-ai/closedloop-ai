import { usePostHog } from "@posthog/next";
import { useUser } from "@repo/auth/client";
import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@posthog/next", () => ({
  usePostHog: vi.fn(),
}));

vi.mock("@repo/auth/client", () => ({
  useUser: vi.fn(),
}));

import { useIdentifyUser } from "./use-identify-user";

const posthog = {
  identify: vi.fn(),
  reset: vi.fn(),
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(usePostHog).mockReturnValue(posthog as never);
});

afterEach(() => {
  cleanup();
});

describe("useIdentifyUser", () => {
  it("waits for the user provider to load", () => {
    vi.mocked(useUser).mockReturnValue({
      isLoaded: false,
      user: null,
    } as never);

    renderHook(() => useIdentifyUser());

    expect(posthog.identify).not.toHaveBeenCalled();
    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it("identifies the loaded user with current and initial properties", () => {
    vi.mocked(useUser).mockReturnValue({
      isLoaded: true,
      user: {
        id: "user-1",
        primaryEmailAddress: { emailAddress: "user@example.com" },
        fullName: "Ada Lovelace",
        lastSignInAt: new Date("2026-08-07T12:00:00.000Z"),
        createdAt: new Date("2026-01-02T03:04:05.000Z"),
      },
    } as never);

    renderHook(() => useIdentifyUser());

    expect(posthog.identify).toHaveBeenCalledWith(
      "user-1",
      {
        email: "user@example.com",
        name: "Ada Lovelace",
        "Latest Login Date": "2026-08-07T12:00:00.000Z",
      },
      { "Initial Signup Date": "2026-01-02T03:04:05.000Z" }
    );
    expect(posthog.reset).not.toHaveBeenCalled();
  });

  it("resets analytics after loading a signed-out user", () => {
    vi.mocked(useUser).mockReturnValue({ isLoaded: true, user: null } as never);

    renderHook(() => useIdentifyUser());

    expect(posthog.reset).toHaveBeenCalledOnce();
    expect(posthog.identify).not.toHaveBeenCalled();
  });
});
