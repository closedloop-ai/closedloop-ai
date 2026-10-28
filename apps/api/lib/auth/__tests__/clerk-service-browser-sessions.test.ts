import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSessionList: vi.fn(),
  getSession: vi.fn(),
  revokeSession: vi.fn(),
}));

vi.mock("@repo/auth/server", () => ({
  clerkClient: vi.fn(async () => ({
    sessions: {
      getSessionList: mocks.getSessionList,
      getSession: mocks.getSession,
      revokeSession: mocks.revokeSession,
    },
  })),
}));

import { clerkService } from "../clerk-service";

const LAST_ACTIVE_MS = 1_788_460_403_425;
const EXPIRE_MS = 1_789_065_203_425;

function clerkRow(overrides: Record<string, unknown> = {}) {
  return {
    id: "sess_1",
    lastActiveAt: LAST_ACTIVE_MS,
    expireAt: EXPIRE_MS,
    latestActivity: {
      browserName: "Chrome",
      browserVersion: "148.0.7778.96",
      deviceType: "Macintosh",
      isMobile: false,
      city: "Austin",
      country: "United States",
    },
    ...overrides,
  };
}

describe("clerkService.listUserBrowserSessions", () => {
  beforeEach(() => {
    mocks.getSessionList.mockReset();
    mocks.getSession.mockReset();
    mocks.revokeSession.mockReset();
  });

  it("asks the provider only for the user's active sessions, with the given bounds", async () => {
    mocks.getSessionList.mockResolvedValue({ data: [], totalCount: 0 });

    await clerkService.listUserBrowserSessions({
      userId: "user_1",
      limit: 20,
      offset: 40,
    });

    expect(mocks.getSessionList).toHaveBeenCalledWith({
      userId: "user_1",
      status: "active",
      limit: 20,
      offset: 40,
    });
  });

  it("maps activity and converts provider epoch millis to ISO", async () => {
    mocks.getSessionList.mockResolvedValue({
      data: [clerkRow()],
      totalCount: 1,
    });

    const page = await clerkService.listUserBrowserSessions({
      userId: "user_1",
      limit: 20,
      offset: 0,
    });

    expect(page.totalCount).toBe(1);
    expect(page.sessions[0]).toEqual({
      id: "sess_1",
      lastActiveAt: new Date(LAST_ACTIVE_MS).toISOString(),
      expireAt: new Date(EXPIRE_MS).toISOString(),
      activity: {
        browserName: "Chrome",
        browserVersion: "148.0.7778.96",
        deviceType: "Macintosh",
        isMobile: false,
        city: "Austin",
        country: "United States",
      },
    });
  });

  it("represents a provider row carrying no activity as null, not as blank fields", async () => {
    mocks.getSessionList.mockResolvedValue({
      data: [clerkRow({ latestActivity: undefined })],
      totalCount: 1,
    });

    const page = await clerkService.listUserBrowserSessions({
      userId: "user_1",
      limit: 20,
      offset: 0,
    });

    // null is the honest answer: the provider said nothing, which is not the
    // same as saying the browser is unknown.
    expect(page.sessions[0].activity).toBeNull();
    expect(page.sessions[0].id).toBe("sess_1");
  });

  it("omits absent activity fields rather than serializing them as null", async () => {
    mocks.getSessionList.mockResolvedValue({
      data: [
        clerkRow({
          latestActivity: {
            city: "Toronto",
            country: "Canada",
            browserName: undefined,
            deviceType: null,
          },
        }),
      ],
      totalCount: 1,
    });

    const page = await clerkService.listUserBrowserSessions({
      userId: "user_1",
      limit: 20,
      offset: 0,
    });

    const { activity } = page.sessions[0];
    expect(activity).toEqual({ city: "Toronto", country: "Canada" });
    // Omission, not null: an older Desktop build parses a missing key.
    expect(Object.hasOwn(activity ?? {}, "browserName")).toBe(false);
    expect(Object.hasOwn(activity ?? {}, "deviceType")).toBe(false);
  });

  it("omits a blank activity field, and keeps a real `false`", async () => {
    mocks.getSessionList.mockResolvedValue({
      data: [
        clerkRow({
          latestActivity: {
            // GeoIP answers "" when it cannot place the address. Passing that
            // through renders an empty location beside a real country.
            city: "",
            country: "Canada",
            browserName: "   ",
            isMobile: false,
          },
        }),
      ],
      totalCount: 1,
    });

    const page = await clerkService.listUserBrowserSessions({
      userId: "user_1",
      limit: 20,
      offset: 0,
    });

    const { activity } = page.sessions[0];
    expect(Object.hasOwn(activity ?? {}, "city")).toBe(false);
    expect(Object.hasOwn(activity ?? {}, "browserName")).toBe(false);
    // `false` is a measured answer, not a blank one — dropping it would report
    // every desktop browser as an unknown form factor.
    expect(activity).toEqual({ country: "Canada", isMobile: false });
  });

  it("propagates a provider failure instead of reporting an empty page", async () => {
    mocks.getSessionList.mockRejectedValue(new Error("clerk down"));

    await expect(
      clerkService.listUserBrowserSessions({
        userId: "user_1",
        limit: 20,
        offset: 0,
      })
    ).rejects.toThrow("clerk down");
  });
});

describe("clerkService.getBrowserSessionOwner", () => {
  beforeEach(() => {
    mocks.getSession.mockReset();
  });

  it("returns the owner for a known session", async () => {
    mocks.getSession.mockResolvedValue({ id: "sess_1", userId: "user_1" });

    await expect(
      clerkService.getBrowserSessionOwner("sess_1")
    ).resolves.toEqual({ userId: "user_1" });
  });

  it("returns null on a provider 404", async () => {
    mocks.getSession.mockRejectedValue({ status: 404 });

    await expect(
      clerkService.getBrowserSessionOwner("sess_missing")
    ).resolves.toBeNull();
  });

  it("propagates a non-404 failure so an outage cannot read as a missing session", async () => {
    mocks.getSession.mockRejectedValue({ status: 503 });

    await expect(clerkService.getBrowserSessionOwner("sess_1")).rejects.toEqual(
      { status: 503 }
    );
  });
});

describe("clerkService.revokeBrowserSession", () => {
  beforeEach(() => {
    mocks.revokeSession.mockReset();
  });

  it("treats an already-revoked session as satisfied", async () => {
    mocks.revokeSession.mockRejectedValue({ status: 404 });

    await expect(
      clerkService.revokeBrowserSession("sess_gone")
    ).resolves.toBeUndefined();
  });

  it("propagates a non-404 revoke failure", async () => {
    mocks.revokeSession.mockRejectedValue({ status: 500 });

    await expect(clerkService.revokeBrowserSession("sess_1")).rejects.toEqual({
      status: 500,
    });
  });
});
