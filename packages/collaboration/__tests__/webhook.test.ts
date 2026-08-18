import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  createWebhookHandler,
  getLiveblocksApiClient,
} from "../server/webhook";

const { constructorCalls, secrets } = vi.hoisted(() => ({
  constructorCalls: [] as { kind: string; secret: string }[],
  secrets: {
    api: "sk_test-secret" as string | undefined,
    webhook: "whsec_test-secret" as string | undefined,
  },
}));

vi.mock("@liveblocks/node", () => ({
  Liveblocks: class {
    constructor({ secret }: { secret: string }) {
      constructorCalls.push({ kind: "api", secret });
    }
  },
  WebhookHandler: class {
    constructor(secret: string) {
      constructorCalls.push({ kind: "webhook", secret });
    }
  },
}));

vi.mock("../server/keys", () => ({
  keys: () => ({
    LIVEBLOCKS_SECRET: secrets.api,
    LIVEBLOCKS_WEBHOOK_SECRET: secrets.webhook,
  }),
}));

describe("Liveblocks webhook boundaries", () => {
  beforeEach(() => {
    constructorCalls.length = 0;
    secrets.api = "sk_test-secret";
    secrets.webhook = "whsec_test-secret";
  });

  it("constructs configured verification and API clients with their own secrets", () => {
    expect(createWebhookHandler()).not.toBeNull();
    expect(getLiveblocksApiClient()).not.toBeNull();
    expect(constructorCalls).toEqual([
      { kind: "webhook", secret: "whsec_test-secret" },
      { kind: "api", secret: "sk_test-secret" },
    ]);
  });

  it("returns null independently for each absent secret", () => {
    secrets.webhook = undefined;
    expect(createWebhookHandler()).toBeNull();
    expect(getLiveblocksApiClient()).not.toBeNull();

    secrets.webhook = "whsec_test-secret";
    secrets.api = undefined;
    expect(createWebhookHandler()).not.toBeNull();
    expect(getLiveblocksApiClient()).toBeNull();
  });
});
