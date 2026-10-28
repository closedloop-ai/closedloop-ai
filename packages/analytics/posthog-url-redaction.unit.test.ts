/**
 * Drives the hooks `installAnalyticsUrlRedaction` installs against a stub
 * client, for the input shapes a real posthog-js capture never produces in the
 * integration suite (`./posthog-url-redaction.test.tsx`).
 */
import { beforeEach, describe, expect, it } from "vitest";
import { installAnalyticsUrlRedaction } from "./posthog-url-redaction";

const MARKER = "[redacted]";
const SECRET = "unit-csrf-5e1a";
const AUTHORIZE_URL = `https://app.example.com/settings/integrations/desktop/authorize?state=${SECRET}`;
const REDACTED_AUTHORIZE_URL =
  "https://app.example.com/settings/integrations/desktop/authorize?state=[redacted]";

type Hook = (value: unknown) => unknown;

type StubClient = {
  config: {
    before_send?: Hook | Hook[];
    session_recording: Record<string, unknown>;
  };
  persistence: undefined;
  set_config: (update: Partial<StubClient["config"]>) => void;
};

function createStubClient(): StubClient {
  const client: StubClient = {
    config: { session_recording: {} },
    persistence: undefined,
    set_config: (update) => {
      client.config = { ...client.config, ...update };
    },
  };
  return client;
}

function installOnStub() {
  const client = createStubClient();
  installAnalyticsUrlRedaction(client as never);
  const chain = client.config.before_send;
  if (!Array.isArray(chain)) {
    throw new Error("before_send was not installed as a chain");
  }
  const beforeSend = chain.at(-1) as Hook;
  const masker = client.config.session_recording
    .maskCapturedNetworkRequestFn as Hook;
  return { beforeSend, masker, client };
}

let hooks: ReturnType<typeof installOnStub>;

beforeEach(() => {
  hooks = installOnStub();
});

describe("installAnalyticsUrlRedaction on a client with no persistence", () => {
  it("installs without touching a store it does not have", () => {
    expect(Array.isArray(hooks.client.config.before_send)).toBe(true);
  });
});

describe("the installed before_send hook", () => {
  it("passes a null event through as null", () => {
    expect(hooks.beforeSend(null)).toBeNull();
  });

  it("redacts a url carried in $set", () => {
    const result = hooks.beforeSend({
      event: "custom",
      properties: {},
      $set: { $current_url: AUTHORIZE_URL },
    }) as { $set: Record<string, unknown> };

    expect(result.$set.$current_url).toBe(REDACTED_AUTHORIZE_URL);
  });

  it("leaves $set absent on an event that carried none", () => {
    const result = hooks.beforeSend({ event: "custom", properties: {} });

    expect(result).not.toHaveProperty("$set");
    expect(result).not.toHaveProperty("$set_once");
  });

  it("walks into a null-prototype object like a plain one", () => {
    const nested = Object.assign(Object.create(null), {
      href: AUTHORIZE_URL,
    }) as Record<string, unknown>;

    const result = hooks.beforeSend({
      event: "custom",
      properties: { nested },
    }) as { properties: { nested: Record<string, unknown> } };

    expect(result.properties.nested.href).toBe(REDACTED_AUTHORIZE_URL);
  });

  it("passes a class instance through unwalked", () => {
    const at = new Date(0);

    const result = hooks.beforeSend({
      event: "custom",
      properties: { at },
    }) as { properties: { at: unknown } };

    expect(result.properties.at).toBe(at);
  });
});

describe("the installed network request masker", () => {
  it("redacts a string request name", () => {
    const result = hooks.masker({ name: AUTHORIZE_URL }) as { name: string };

    expect(result.name).toBe(REDACTED_AUTHORIZE_URL);
    expect(result.name.includes(MARKER)).toBe(true);
  });

  it("carries a non-string request name through as given", () => {
    const result = hooks.masker({
      name: undefined,
      requestBody: "body",
      responseBody: "body",
    });

    expect(result).toEqual({
      name: undefined,
      requestBody: null,
      responseBody: null,
    });
  });
});
