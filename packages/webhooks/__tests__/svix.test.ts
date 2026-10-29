import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  svixConstructor: vi.fn(),
  messageCreate: vi.fn(),
  appPortalAccess: vi.fn(),
}));

vi.mock("server-only", () => ({}));
vi.mock("@repo/auth/server", () => ({ auth: mocks.auth }));
vi.mock("svix", () => ({
  Svix: class {
    message = { create: mocks.messageCreate };
    authentication = { appPortalAccess: mocks.appPortalAccess };

    constructor(token: string) {
      mocks.svixConstructor(token);
    }
  },
}));

const CONFIGURED_TOKEN = "testsk_configured";
const ORG_ID = "org_2abc";
const EVENT_TYPE = "document.created";

describe("packages/webhooks svix", () => {
  let originalToken: string | undefined;

  beforeEach(() => {
    originalToken = process.env.SVIX_TOKEN;
  });

  afterEach(() => {
    if (originalToken === undefined) {
      Reflect.deleteProperty(process.env, "SVIX_TOKEN");
    } else {
      process.env.SVIX_TOKEN = originalToken;
    }
    vi.clearAllMocks();
    vi.resetModules();
  });

  // The whole point of ISS-6667: the two entry points deliberately DISAGREE on
  // what an unconfigured Svix means. Asserted against ONE module instance,
  // because `svixToken` is captured at module scope — two separate loads could
  // each be exercising a different branch and both assertions would pass
  // vacuously.
  it("throws from send() but resolves undefined from getAppPortal() when SVIX_TOKEN is unset", async () => {
    const svix = await loadSvix(undefined);

    await expect(
      svix.send(EVENT_TYPE, { documentId: "doc_1" })
    ).rejects.toThrow("SVIX_TOKEN is not set");
    await expect(svix.getAppPortal()).resolves.toBeUndefined();

    // Proves the undefined came from the missing-token guard and not from the
    // `!orgId` early return further down, which would make the asymmetry an
    // accident of test setup rather than the contract.
    expect(mocks.auth).not.toHaveBeenCalled();
    expect(mocks.svixConstructor).not.toHaveBeenCalled();
  });

  // Same module instance again, this time WITH a token: send() not throwing here
  // is what proves the case above exercised the unconfigured branch rather than
  // a stale module-scope capture.
  it("resolves undefined from both entry points when the session has no orgId", async () => {
    mocks.auth.mockResolvedValue({ orgId: null });
    const svix = await loadSvix(CONFIGURED_TOKEN);

    await expect(
      svix.send(EVENT_TYPE, { documentId: "doc_1" })
    ).resolves.toBeUndefined();
    await expect(svix.getAppPortal()).resolves.toBeUndefined();

    expect(mocks.messageCreate).not.toHaveBeenCalled();
    expect(mocks.appPortalAccess).not.toHaveBeenCalled();
  });

  it("sends with orgId as both the application name and uid, and nests eventType into the payload", async () => {
    mocks.auth.mockResolvedValue({ orgId: ORG_ID });
    mocks.messageCreate.mockResolvedValue({ id: "msg_1" });
    const svix = await loadSvix(CONFIGURED_TOKEN);

    await expect(
      svix.send(EVENT_TYPE, { documentId: "doc_1" })
    ).resolves.toEqual({ id: "msg_1" });

    expect(mocks.svixConstructor).toHaveBeenCalledWith(CONFIGURED_TOKEN);
    expect(mocks.messageCreate).toHaveBeenCalledWith(ORG_ID, {
      eventType: EVENT_TYPE,
      payload: { eventType: EVENT_TYPE, documentId: "doc_1" },
      application: { name: ORG_ID, uid: ORG_ID },
    });
  });

  it("requests app-portal access with orgId as both the application name and uid", async () => {
    mocks.auth.mockResolvedValue({ orgId: ORG_ID });
    mocks.appPortalAccess.mockResolvedValue({
      url: "https://app.svix.com/login#key=abc",
    });
    const svix = await loadSvix(CONFIGURED_TOKEN);

    await expect(svix.getAppPortal()).resolves.toEqual({
      url: "https://app.svix.com/login#key=abc",
    });

    expect(mocks.appPortalAccess).toHaveBeenCalledWith(ORG_ID, {
      application: { name: ORG_ID, uid: ORG_ID },
    });
  });

  // The `webhooks` object is what apps/app actually imports; a barrel that
  // stopped re-exporting these would leave every test above green.
  it("exposes both entry points on the webhooks barrel", async () => {
    const svix = await loadSvix(CONFIGURED_TOKEN);
    const { webhooks } = await import("../index");

    expect(webhooks.send).toBe(svix.send);
    expect(webhooks.getAppPortal).toBe(svix.getAppPortal);
  });
});

/**
 * `lib/svix.ts` reads `keys().SVIX_TOKEN` once at module scope, so the env has
 * to be in its final state BEFORE the module graph is rebuilt. Mutating
 * `process.env` around a static import would leave the first-imported value in
 * place and make both the configured and unconfigured cases assert the same
 * branch.
 */
async function loadSvix(token: string | undefined) {
  if (token === undefined) {
    Reflect.deleteProperty(process.env, "SVIX_TOKEN");
  } else {
    process.env.SVIX_TOKEN = token;
  }
  vi.resetModules();
  return await import("../lib/svix");
}
