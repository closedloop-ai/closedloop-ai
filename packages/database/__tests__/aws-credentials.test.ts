import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * ISS-9108. `packages/database` resolved credentials through Vercel OIDC only,
 * which throws outside Vercel and so kept a containerized `apps/api` from ever
 * reaching the database.
 *
 * The load-bearing case here is the FIRST one: this is the credential path for
 * every `apps/api` request, so a suite that only proved the new fallback works
 * would let a regression silently move production onto a different credential
 * source. Both providers are mocked with distinguishable secrets so an
 * assertion cannot be satisfied by "the other provider happened to resolve
 * too".
 */

const OIDC_CREDENTIALS = {
  accessKeyId: "AKIA-OIDC-ONLY",
  secretAccessKey: "oidc-secret-do-not-log",
  sessionToken: "oidc-session-token-do-not-log",
};

const CHAIN_CREDENTIALS = {
  accessKeyId: "AKIA-CHAIN-ONLY",
  secretAccessKey: "chain-secret-do-not-log",
  sessionToken: "chain-session-token-do-not-log",
};

const ROLE_ARN = "arn:aws:iam::123456789012:role/vercel-rds-iam";
const REGION = "us-east-1";

const oidcProvider = vi.fn();
const awsCredentialsProvider = vi.fn<(init: unknown) => typeof oidcProvider>(
  () => oidcProvider
);

const chainProvider = vi.fn();
const defaultProvider = vi.fn<(init: unknown) => typeof chainProvider>(
  () => chainProvider
);

vi.mock("@vercel/functions/oidc", () => ({
  awsCredentialsProvider: (init: unknown) => awsCredentialsProvider(init),
}));

vi.mock("@aws-sdk/credential-provider-node", () => ({
  defaultProvider: (init: unknown) => defaultProvider(init),
}));

const CONSOLE_METHODS = ["log", "info", "warn", "error", "debug"] as const;

/**
 * Saved and restored rather than deleted: the runner may have inherited either
 * value, and a worker that leaves them cleared hands every later file in it a
 * different deployment mode than it started with.
 */
const VERCEL_ENV_KEYS = ["VERCEL", "VERCEL_ENV", "VERCEL_OIDC_TOKEN"] as const;

describe("createRdsCredentialsProvider", () => {
  let consoleSpies: ReturnType<typeof vi.spyOn>[];
  let savedEnv: Partial<Record<(typeof VERCEL_ENV_KEYS)[number], string>>;

  beforeEach(() => {
    savedEnv = Object.fromEntries(
      VERCEL_ENV_KEYS.map((key) => [key, process.env[key]])
    );
    oidcProvider.mockReset().mockResolvedValue(OIDC_CREDENTIALS);
    chainProvider.mockReset().mockResolvedValue(CHAIN_CREDENTIALS);
    awsCredentialsProvider.mockClear();
    defaultProvider.mockClear();
    consoleSpies = CONSOLE_METHODS.map((method) =>
      vi.spyOn(console, method).mockImplementation(() => {
        // Swallowed so a stray log is proven by the spy rather than printed.
      })
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    for (const key of VERCEL_ENV_KEYS) {
      const value = savedEnv[key];
      if (value === undefined) {
        Reflect.deleteProperty(process.env, key);
      } else {
        process.env[key] = value;
      }
    }
  });

  function loggedArguments() {
    return consoleSpies.flatMap((spy) => spy.mock.calls);
  }

  it("uses the Vercel OIDC provider when it resolves, and never touches the AWS chain", async () => {
    const provider = await loadProvider();

    await expect(provider()).resolves.toEqual(OIDC_CREDENTIALS);
    expect(awsCredentialsProvider).toHaveBeenCalledWith({
      roleArn: ROLE_ARN,
      clientConfig: { region: REGION },
    });
    expect(oidcProvider).toHaveBeenCalledTimes(1);
    expect(defaultProvider).not.toHaveBeenCalled();
    expect(chainProvider).not.toHaveBeenCalled();
  });

  it("falls back to the AWS credential chain when the OIDC provider throws", async () => {
    oidcProvider.mockRejectedValue(new Error("no OIDC token in this runtime"));

    const provider = await loadProvider();

    await expect(provider()).resolves.toEqual(CHAIN_CREDENTIALS);
    expect(oidcProvider).toHaveBeenCalledTimes(1);
    expect(defaultProvider).toHaveBeenCalledWith({
      clientConfig: { region: REGION },
    });
  });

  it("selects on whether OIDC resolves, not on VERCEL environment variables", async () => {
    process.env.VERCEL = "1";
    process.env.VERCEL_ENV = "production";
    oidcProvider.mockRejectedValue(new Error("no OIDC token in this runtime"));

    const onVercelLooking = await loadProvider();
    await expect(onVercelLooking()).resolves.toEqual(CHAIN_CREDENTIALS);

    Reflect.deleteProperty(process.env, "VERCEL");
    Reflect.deleteProperty(process.env, "VERCEL_ENV");
    oidcProvider.mockResolvedValue(OIDC_CREDENTIALS);

    const offVercelLooking = await loadProvider();
    await expect(offVercelLooking()).resolves.toEqual(OIDC_CREDENTIALS);
  });

  it("latches the winning provider so a later OIDC failure cannot silently switch sources", async () => {
    // Already expired, so the second call waits on the source.
    const expired = { ...OIDC_CREDENTIALS, expiration: expiresIn(-1) };
    oidcProvider.mockResolvedValueOnce(expired);
    const provider = await loadProvider();
    await expect(provider()).resolves.toBe(expired);

    const transient = new Error("STS timed out");
    oidcProvider.mockRejectedValue(transient);

    await expect(provider()).rejects.toBe(transient);
    expect(defaultProvider).not.toHaveBeenCalled();
    expect(chainProvider).not.toHaveBeenCalled();
  });

  it("runs one selection for a burst of concurrent first calls", async () => {
    let releaseChain: (value: typeof CHAIN_CREDENTIALS) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    chainProvider.mockReturnValue(
      new Promise((resolve) => {
        releaseChain = resolve;
      })
    );

    // No role ARN, so selection is the chain alone: a burst that arrives while
    // the first selection is still in flight has exactly one observable
    // outcome to count, with no OIDC attempt in the way.
    const provider = await loadProviderWithoutRole();
    const burst = [provider(), provider(), provider(), provider()];
    releaseChain(CHAIN_CREDENTIALS);

    await expect(Promise.all(burst)).resolves.toEqual([
      CHAIN_CREDENTIALS,
      CHAIN_CREDENTIALS,
      CHAIN_CREDENTIALS,
      CHAIN_CREDENTIALS,
    ]);
    expect(defaultProvider).toHaveBeenCalledTimes(1);
    expect(chainProvider).toHaveBeenCalledTimes(1);
  });

  it("reuses resolved credentials for every new connection until they near expiry", async () => {
    // ISS-10507: the OIDC provider is an STS call per invocation, and pg.Pool
    // invokes this once per new connection.
    oidcProvider.mockResolvedValue({
      ...OIDC_CREDENTIALS,
      expiration: expiresIn(60 * 60 * 1000),
    });
    const provider = await loadProvider();

    await provider();
    await provider();
    await provider();

    expect(oidcProvider).toHaveBeenCalledTimes(1);
  });

  it("refreshes behind the cache once the credentials enter the SDK's five-minute refresh window", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-09-29T00:00:00Z"));
    const first = {
      ...OIDC_CREDENTIALS,
      expiration: new Date("2026-09-29T01:00:00Z"),
    };
    const refreshed = {
      ...OIDC_CREDENTIALS,
      accessKeyId: "AKIA-OIDC-REFRESHED",
      expiration: new Date("2026-09-29T02:00:00Z"),
    };
    oidcProvider.mockResolvedValueOnce(first).mockResolvedValueOnce(refreshed);
    const provider = await loadProvider();
    await expect(provider()).resolves.toBe(first);

    vi.setSystemTime(new Date("2026-09-29T00:54:59Z"));
    await expect(provider()).resolves.toBe(first);
    expect(oidcProvider).toHaveBeenCalledTimes(1);

    vi.setSystemTime(new Date("2026-09-29T00:55:01Z"));
    await expect(provider()).resolves.toBe(first);
    await afterPendingMicrotasks();
    await expect(provider()).resolves.toBe(refreshed);
    expect(oidcProvider).toHaveBeenCalledTimes(2);
  });

  it("serves unexpired credentials while a stalled refresh runs behind them", async () => {
    // ISS-10507's trace: one STS call got no response for 15.3s. A connection
    // opened inside the refresh window must not wait on it.
    const nearExpiry = { ...OIDC_CREDENTIALS, expiration: expiresIn(60_000) };
    let failStalledRefresh: (error: Error) => void = () => {
      // Replaced synchronously by the promise executor below.
    };
    oidcProvider.mockResolvedValueOnce(nearExpiry).mockReturnValueOnce(
      new Promise((_, reject) => {
        failStalledRefresh = reject;
      })
    );
    const provider = await loadProvider();
    await provider();

    await expect(
      Promise.race([provider(), afterPendingMicrotasks()])
    ).resolves.toBe(nearExpiry);

    // A failed refresh leaves the cache in place instead of clearing it.
    failStalledRefresh(new Error("STS timed out"));
    await afterPendingMicrotasks();
    await expect(provider()).resolves.toBe(nearExpiry);
  });

  it("reuses credentials that carry no expiration for every new connection", async () => {
    // Static credentials (environment keys, a profile) have no expiration.
    const provider = await loadProviderWithoutRole();

    await provider();
    await provider();
    await provider();

    expect(chainProvider).toHaveBeenCalledTimes(1);
  });

  it("shares one refresh across a burst of new connections", async () => {
    // The prod trace behind ISS-10507 opened eight connections in one request
    // and made eight STS calls.
    oidcProvider.mockResolvedValue({
      ...OIDC_CREDENTIALS,
      expiration: expiresIn(60_000),
    });
    const provider = await loadProvider();
    await provider();

    await Promise.all(Array.from({ length: 8 }, () => provider()));

    expect(oidcProvider).toHaveBeenCalledTimes(2);
  });

  it("retries selection after both paths failed rather than latching the failure", async () => {
    oidcProvider.mockRejectedValue(new Error("no OIDC token in this runtime"));
    chainProvider.mockRejectedValueOnce(new Error("no container credentials"));

    const provider = await loadProvider();
    await expect(provider()).rejects.toThrow(
      "Unable to resolve AWS credentials"
    );

    await expect(provider()).resolves.toEqual(CHAIN_CREDENTIALS);
  });

  it("uses the chain without attempting OIDC when no role ARN is configured", async () => {
    const provider = await loadProviderWithoutRole();

    await expect(provider()).resolves.toEqual(CHAIN_CREDENTIALS);
    expect(awsCredentialsProvider).not.toHaveBeenCalled();
    expect(oidcProvider).not.toHaveBeenCalled();
    expect(defaultProvider).toHaveBeenCalledWith({
      clientConfig: { region: REGION },
    });
  });

  it("says OIDC was never attempted when no role ARN is configured and the chain fails", async () => {
    chainProvider.mockRejectedValue(new Error("no container credentials"));

    const provider = await loadProviderWithoutRole();
    const error = await provider().catch((thrown: unknown) => thrown);

    expect((error as Error).message).toContain("never attempted");
    expect((error as Error).message).toContain("AWS credential chain");
  });

  it("names both attempted paths when neither resolves", async () => {
    const oidcFailure = new TypeError("missing OIDC token");
    const chainFailure = new RangeError("no container credentials");
    oidcProvider.mockRejectedValue(oidcFailure);
    chainProvider.mockRejectedValue(chainFailure);

    const provider = await loadProvider();
    const error = await provider().catch((thrown: unknown) => thrown);

    expect(error).toBeInstanceOf(Error);
    const message = (error as Error).message;
    expect(message).toContain("@vercel/functions/oidc");
    expect(message).toContain("AWS credential chain");
    expect(message).toContain("container/task role");
    expect(message).toContain("TypeError");
    expect(message).toContain("RangeError");
  });

  it("names the SDK code and HTTP status so identical CredentialsProviderErrors stay apart", async () => {
    // No task role attached, AccessDenied on the assume, and a wrong region are
    // all reported by the chain as a bare `CredentialsProviderError`. Without
    // these two fields the three produce byte-identical text, which is a bisect
    // rather than a fix during a database outage.
    oidcProvider.mockRejectedValue(
      Object.assign(new Error("redacted"), {
        name: "CredentialsProviderError",
        code: "AccessDenied",
        $metadata: { httpStatusCode: 403 },
      })
    );
    chainProvider.mockRejectedValue(
      Object.assign(new Error("redacted"), {
        name: "CredentialsProviderError",
        code: "CredentialsNotLoaded",
      })
    );

    const provider = await loadProvider();
    const error = await provider().catch((thrown: unknown) => thrown);
    const message = (error as Error).message;

    expect(message).toContain(
      "CredentialsProviderError (code AccessDenied, HTTP 403)"
    );
    expect(message).toContain(
      "CredentialsProviderError (code CredentialsNotLoaded)"
    );
  });

  it("keeps credentials, tokens, and the role ARN out of the error text and out of every log", async () => {
    const secretBearingFailure = new Error(
      `User ${ROLE_ARN} is not authorized with ${OIDC_CREDENTIALS.sessionToken}`
    );
    oidcProvider.mockRejectedValue(secretBearingFailure);
    chainProvider.mockRejectedValue(
      new Error(`chain leaked ${CHAIN_CREDENTIALS.secretAccessKey}`)
    );

    const provider = await loadProvider();
    const error = await provider().catch((thrown: unknown) => thrown);
    // What a caller logs is the whole error, and Node's formatter walks
    // `cause` -- so the assertion has to be against the serialized form, not
    // against `.message` alone.
    const serialized = inspect(error, { depth: null });

    for (const secret of [
      ROLE_ARN,
      OIDC_CREDENTIALS.secretAccessKey,
      OIDC_CREDENTIALS.sessionToken,
      CHAIN_CREDENTIALS.secretAccessKey,
      CHAIN_CREDENTIALS.sessionToken,
    ]) {
      expect(serialized).not.toContain(secret);
    }
    expect(loggedArguments()).toEqual([]);
  });

  it("logs nothing on the successful OIDC and fallback paths either", async () => {
    const onOidc = await loadProvider();
    await onOidc();

    oidcProvider.mockRejectedValue(new Error("no OIDC token in this runtime"));
    const onChain = await loadProvider();
    await onChain();

    expect(loggedArguments()).toEqual([]);
  });
});

async function loadProvider() {
  const { createRdsCredentialsProvider } = await import("../aws-credentials");
  return createRdsCredentialsProvider({ roleArn: ROLE_ARN, region: REGION });
}

async function loadProviderWithoutRole() {
  const { createRdsCredentialsProvider } = await import("../aws-credentials");
  return createRdsCredentialsProvider({ roleArn: undefined, region: REGION });
}

function expiresIn(ms: number): Date {
  return new Date(Date.now() + ms);
}

/**
 * Settles only after every pending microtask has run, so a call that resolves
 * without waiting on I/O wins a race against it.
 */
function afterPendingMicrotasks(): Promise<typeof STILL_WAITING> {
  return new Promise((resolve) => {
    setImmediate(() => resolve(STILL_WAITING));
  });
}

const STILL_WAITING = Symbol("still-waiting");
