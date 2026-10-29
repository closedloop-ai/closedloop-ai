import { DesktopSignInAnalyticsPath } from "@repo/api/src/types/desktop-sign-in-analytics";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { DesktopAuthorizeRun } from "../desktop-authorize-run";

const mocks = vi.hoisted(() => ({
  after: vi.fn(),
  getUser: vi.fn(),
  fetch: vi.fn(),
}));
vi.mock("next/server", () => ({ after: mocks.after }));
vi.mock("@repo/auth/server", () => ({
  clerkClient: async () => ({ users: { getUser: mocks.getUser } }),
}));
vi.mock("../api-origin", () => ({
  resolveApiOrigin: () => "https://api.example.test",
}));

import { scheduleDesktopSignInAnalyticsReport } from "../desktop-sign-in-analytics";

const run: DesktopAuthorizeRun = {
  v: 1,
  state: "s",
  query: "code_challenge=cookie-challenge",
  issuedAt: 1000,
};
const session = async () => ({
  userId: "user_1",
  getToken: async () => "clerk-token",
});
beforeEach(() => {
  vi.clearAllMocks();
  vi.stubGlobal("fetch", mocks.fetch);
  mocks.getUser.mockResolvedValue({ id: "user_1", createdAt: 1100 });
});
afterEach(() => vi.unstubAllGlobals());
it("schedules rather than awaiting, takes challenge from cookie and leaves cookie intact", async () => {
  const original = { ...run };
  scheduleDesktopSignInAnalyticsReport(run, session);
  expect(mocks.fetch).not.toHaveBeenCalled();
  await mocks.after.mock.calls[0][0]();
  expect(mocks.fetch).toHaveBeenCalledWith(
    new URL(DesktopSignInAnalyticsPath.Report, "https://api.example.test"),
    expect.objectContaining({
      body: JSON.stringify({ codeChallenge: "cookie-challenge" }),
      headers: {
        "content-type": "application/json",
        authorization: "Bearer clerk-token",
      },
    })
  );
  expect(run).toEqual(original);
});
it.each([null, { ...run, consumed: true as const }])(
  "ignores absent/consumed run",
  (value) => {
    scheduleDesktopSignInAnalyticsReport(value, session);
    expect(mocks.after).not.toHaveBeenCalled();
  }
);
it("an older account or other cookie owner is not reported", async () => {
  mocks.getUser.mockResolvedValue({ id: "user_1", createdAt: 999 });
  scheduleDesktopSignInAnalyticsReport(run, session);
  await mocks.after.mock.calls[0][0]();
  scheduleDesktopSignInAnalyticsReport(
    { ...run, userId: "user_other" },
    session
  );
  await mocks.after.mock.calls[1][0]();
  expect(mocks.fetch).not.toHaveBeenCalled();
});
it("failure in report or scheduling never escapes", async () => {
  mocks.fetch.mockRejectedValue(new Error("offline"));
  scheduleDesktopSignInAnalyticsReport(run, session);
  await expect(mocks.after.mock.calls[0][0]()).resolves.toBeUndefined();
  mocks.after.mockImplementationOnce(() => {
    throw new Error("scheduler unavailable");
  });
  expect(() =>
    scheduleDesktopSignInAnalyticsReport(run, session)
  ).not.toThrow();
});
