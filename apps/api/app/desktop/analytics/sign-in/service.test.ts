import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hashToken } from "@/lib/auth/token-hash";

const mocks = vi.hoisted(() => ({
  deleteMany: vi.fn(),
  count: vi.fn(),
  createMany: vi.fn(),
  findFirst: vi.fn(),
  query: vi.fn(),
  user: vi.fn(),
  alias: vi.fn(),
  warn: vi.fn(),
}));
vi.mock("@repo/database", () => {
  const db = { desktopSignInAnalyticsAttempt: mocks, $queryRaw: mocks.query };
  const withDb = Object.assign((fn: (value: typeof db) => unknown) => fn(db), {
    tx: (fn: (value: typeof db) => unknown) => fn(db),
  });
  return {
    withDb,
    Prisma: {
      sql: (strings: TemplateStringsArray, ...values: unknown[]) => ({
        strings: [...strings],
        values,
      }),
    },
  };
});
vi.mock("@/lib/auth/clerk-service", () => ({
  clerkService: { getUser: mocks.user },
}));
vi.mock("@/lib/desktop-analytics-capture", () => ({
  aliasDesktopAnalytics: mocks.alias,
}));
vi.mock("@repo/observability/log", () => ({ log: { warn: mocks.warn } }));

import {
  SIGN_IN_ANALYTICS_LIVE_ROW_CAP,
  SIGN_IN_ANALYTICS_TTL_MS,
  desktopSignInAnalyticsService as service,
} from "./service";

const conditionalDelete =
  /DELETE[\s\S]*expires_at > NOW\(\)[\s\S]*created_at <=[\s\S]*expires_at >=[\s\S]*RETURNING/;
const challenge = "A".repeat(43);
const flowId = "11111111-1111-4111-8111-111111111111";
const now = new Date("2026-09-30T12:00:00Z");
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(now);
  mocks.count.mockResolvedValue(0);
  mocks.query.mockResolvedValue([]);
});
afterEach(() => vi.useRealTimers());

describe("guarded analytics join", () => {
  it("registers first-write-wins with hash, TTL, cleanup and cap", async () => {
    await service.register({ codeChallenge: challenge, flowId });
    expect(mocks.deleteMany).toHaveBeenCalledWith({
      where: { expiresAt: { lte: now } },
    });
    expect(mocks.createMany).toHaveBeenCalledWith({
      data: [
        {
          challengeHash: hashToken(challenge),
          flowId,
          createdAt: now,
          expiresAt: new Date(now.getTime() + SIGN_IN_ANALYTICS_TTL_MS),
        },
      ],
      skipDuplicates: true,
    });
    expect(mocks.query.mock.calls[0][0].strings.join("")).toContain(
      "pg_advisory_xact_lock"
    );
  });
  it("refuses inserts at the live cap", async () => {
    mocks.count.mockResolvedValue(SIGN_IN_ANALYTICS_LIVE_ROW_CAP);
    await service.register({ codeChallenge: challenge, flowId });
    expect(mocks.createMany).not.toHaveBeenCalled();
    expect(mocks.warn).toHaveBeenCalledWith(
      "Desktop sign-in analytics live-row cap reached",
      {
        status: "warn",
        code: "registration_cap_reached",
        cap: SIGN_IN_ANALYTICS_LIVE_ROW_CAP,
      }
    );
  });
  it("misses and expired entries do not call Clerk", async () => {
    mocks.findFirst.mockResolvedValue(null);
    await service.report(challenge, "user_1");
    expect(mocks.findFirst).toHaveBeenCalledWith({
      where: { challengeHash: hashToken(challenge), expiresAt: { gt: now } },
      select: { createdAt: true, expiresAt: true },
    });
    expect(mocks.user).not.toHaveBeenCalled();
    expect(mocks.alias).not.toHaveBeenCalled();
  });
  it("uses a conditional atomic delete and aliases only its returned flow", async () => {
    mocks.findFirst.mockResolvedValue({
      createdAt: now,
      expiresAt: new Date(now.getTime() + SIGN_IN_ANALYTICS_TTL_MS),
    });
    mocks.user.mockResolvedValue({ createdAt: now.getTime() });
    mocks.query.mockResolvedValueOnce([{ flowId }]).mockResolvedValueOnce([]);
    await service.report(challenge, "user_1");
    await service.report(challenge, "user_1");
    const query = mocks.query.mock.calls[0][0];
    expect(query.strings.join("")).toMatch(conditionalDelete);
    expect(query.values).toEqual([hashToken(challenge), now, now]);
    expect(mocks.alias).toHaveBeenCalledExactlyOnceWith({
      distinctId: "user_1",
      alias: flowId,
    });
  });
  it("a user without primary email or creation evidence consumes nothing", async () => {
    mocks.findFirst.mockResolvedValue({ createdAt: now, expiresAt: now });
    mocks.user.mockRejectedValue(new Error("no primary email"));
    await service.report(challenge, "user_1");
    expect(mocks.query).not.toHaveBeenCalled();
    expect(mocks.alias).not.toHaveBeenCalled();
  });
  it("never logs database error objects or correlation values", async () => {
    mocks.count.mockRejectedValue(new Error(flowId + challenge));
    await expect(
      service.register({ codeChallenge: challenge, flowId })
    ).resolves.toBeUndefined();
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(flowId);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain(challenge);
  });
});
