import { beforeEach, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  register: vi.fn(),
  report: vi.fn(),
  registration: vi.fn(),
  reporting: vi.fn(),
  budget: vi.fn(),
}));
vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));
vi.mock("@/lib/observability/with-request-completed", () => ({
  withRequestCompleted: (handler: unknown) => handler,
}));
vi.mock("@/lib/desktop-analytics-handler", () => ({
  consumeDesktopAnalyticsPreAuthBudget: mocks.budget,
}));
vi.mock("./rate-limit", () => ({
  registrationLimiter: { attempt: mocks.registration },
  reportLimiter: { attempt: mocks.reporting },
}));
vi.mock("./service", () => ({
  desktopSignInAnalyticsService: {
    register: mocks.register,
    report: mocks.report,
  },
}));

import { POST as register } from "./register/route";
import { POST as report } from "./report/route";

const codeChallenge = "A".repeat(43);
const flowId = "11111111-1111-4111-8111-111111111111";
const request = (body: unknown) =>
  new Request("https://api.example.test/desktop/analytics/sign-in/report", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  mocks.auth.mockResolvedValue({
    userId: "user_1",
    sessionId: "session_1",
    orgId: null,
  });
  mocks.registration.mockReturnValue(true);
  mocks.reporting.mockReturnValue(true);
  mocks.budget.mockReturnValue(true);
});
it("accepts a real Clerk session before the user has an org", async () => {
  expect((await report(request({ codeChallenge }))).status).toBe(200);
  expect(mocks.report).toHaveBeenCalledWith(codeChallenge, "user_1");
});
it.each([
  { userId: null, sessionId: null },
  { userId: "user_1", sessionId: null },
])("rejects unauthenticated or API-key-only reports", async (session) => {
  mocks.auth.mockResolvedValue(session);
  expect((await report(request({ codeChallenge }))).status).toBe(401);
  expect(mocks.report).not.toHaveBeenCalled();
});
it("limits reports by authenticated user before lookup", async () => {
  mocks.reporting.mockReturnValue(false);
  expect((await report(request({ codeChallenge }))).status).toBe(429);
  expect(mocks.reporting).toHaveBeenCalledWith("user_1", expect.any(Number));
  expect(mocks.report).not.toHaveBeenCalled();
});
it("registration consumes shared pre-auth budgets before storing", async () => {
  expect((await register(request({ codeChallenge, flowId }))).status).toBe(200);
  expect(mocks.budget).toHaveBeenCalledWith(flowId);
  expect(mocks.register).toHaveBeenCalledWith({ codeChallenge, flowId });
});
it.each(["registration", "budget"] as const)(
  "refuses when %s budget is exhausted",
  async (limiter) => {
    mocks[limiter].mockReturnValue(false);
    expect((await register(request({ codeChallenge, flowId }))).status).toBe(
      429
    );
    expect(mocks.register).not.toHaveBeenCalled();
  }
);
it.each([register, report])(
  "rejects oversized input before the store",
  async (handler) => {
    expect(
      (await handler(request({ codeChallenge: "x".repeat(2048), flowId })))
        .status
    ).toBe(413);
    expect(mocks.register).not.toHaveBeenCalled();
    expect(mocks.report).not.toHaveBeenCalled();
  }
);
it("does not trust client creation or identity claims", async () => {
  expect(
    (
      await report(
        request({ codeChallenge, userId: "other", accountCreated: true })
      )
    ).status
  ).toBe(400);
  expect(mocks.report).not.toHaveBeenCalled();
});
