import { parseChannelAddress } from "@repo/realtime-contract/channels";
import {
  type InternalPublishBody,
  internalPublishBodySchema,
  RealtimeInternalPath,
  type RevokeTarget,
  revokeTargetSchema,
} from "@repo/realtime-contract/internal";
import { SignalTypes } from "@repo/realtime-contract/signals";
import {
  lookupSignalSchema,
  type RealtimeSignal,
  type SignalTypeRegistry,
} from "./emit-signal";
import {
  createInternalServiceCaller,
  InternalCallFailure,
  type InternalServiceConfig,
  parseInternalServiceConfig,
} from "./internal-call";

/**
 * `url` is `REALTIME_INTERNAL_URL`, the service as `apps/api` reaches it;
 * `oidcAudience` is `REALTIME_INTERNAL_OIDC_AUDIENCE`, the audience of the
 * bearer (ISS-11966).
 */
export type RealtimeInternalConfig = InternalServiceConfig;

/**
 * Reads the caller's `REALTIME_INTERNAL_URL` and
 * `REALTIME_INTERNAL_OIDC_AUDIENCE`, which this package never reads from
 * `process.env` itself. An unusable URL, or no audience, returns undefined,
 * and a client built on that answers every call `not_configured` without a
 * request. An audience that is Vercel's default is dropped, never sent.
 */
export function parseRealtimeInternalConfig(env: {
  internalUrl: string | undefined;
  oidcAudience: string | undefined;
}): RealtimeInternalConfig | undefined {
  return parseInternalServiceConfig(env);
}

export const RealtimeCallFailure = InternalCallFailure;
export type RealtimeCallFailure = InternalCallFailure;

/** Local rather than `@repo/api`'s `Result`, which this package does not depend on. */
export type RealtimeCallResult =
  | { ok: true }
  | { ok: false; failure: RealtimeCallFailure; status?: number };

export type RealtimeServerClient = {
  /**
   * Best effort, with no gap detection: a client that misses it is not
   * resynced. For a domain write, `emitSignal` inside the transaction is the
   * default; this is for a signal with no transaction to ride. `signal.data`
   * is checked against the type `registry` declares for the channel's kind,
   * as `emitSignal` checks it.
   */
  publish(
    channel: string,
    signal: RealtimeSignal,
    registry?: SignalTypeRegistry
  ): Promise<RealtimeCallResult>;
  /** Closes the target's channels on every instance with `forbidden`. */
  revoke(target: RevokeTarget): Promise<RealtimeCallResult>;
};

export type RealtimeServerClientOptions = {
  config: RealtimeInternalConfig | undefined;
  fetch?: typeof fetch;
  timeoutMs?: number;
};

/**
 * PLN-2105 step 7: `publish` and `revoke` through the service's internal
 * endpoints. Neither ever throws into the caller's request; each resolves a
 * {@link RealtimeCallResult}. A failure logs
 * {@link REALTIME_INTERNAL_CALL_FAILED_EVENT}, and an unconfigured client logs
 * {@link REALTIME_INTERNAL_NOT_CONFIGURED_EVENT} once.
 */
export function createRealtimeServerClient(
  options: RealtimeServerClientOptions
): RealtimeServerClient {
  const timeoutMs = options.timeoutMs ?? REALTIME_INTERNAL_CALL_TIMEOUT_MS;
  const caller = createInternalServiceCaller({
    config: options.config,
    fetch: options.fetch,
    events: {
      failed: {
        event: REALTIME_INTERNAL_CALL_FAILED_EVENT,
        message: "Realtime internal call failed",
      },
      notConfigured: {
        event: REALTIME_INTERNAL_NOT_CONFIGURED_EVENT,
        message: "Realtime internal calls are not configured",
      },
    },
    accept: (status) => status === HTTP_ACCEPTED,
  });

  const call = async (
    path: RealtimeInternalPath,
    body: unknown
  ): Promise<RealtimeCallResult> => {
    const response = await caller.call({
      method: "POST",
      path,
      body,
      timeoutMs,
    });
    if (response.ok) {
      return { ok: true };
    }
    return response.status === undefined
      ? { ok: false, failure: response.failure }
      : { ok: false, failure: response.failure, status: response.status };
  };

  const invalid = (path: RealtimeInternalPath): RealtimeCallResult => {
    caller.fail(path, RealtimeCallFailure.Invalid);
    return { ok: false, failure: RealtimeCallFailure.Invalid };
  };

  return {
    publish(channel, signal, registry = SignalTypes) {
      const body = publishBody(channel, signal, registry);
      if (body === undefined) {
        return Promise.resolve(invalid(RealtimeInternalPath.Publish));
      }
      return call(RealtimeInternalPath.Publish, body);
    },
    revoke(target) {
      const parsed = revokeTargetSchema.safeParse(target);
      if (!parsed.success) {
        return Promise.resolve(invalid(RealtimeInternalPath.Revoke));
      }
      return call(RealtimeInternalPath.Revoke, { target: parsed.data });
    },
  };
}

function publishBody(
  channel: string,
  signal: RealtimeSignal,
  registry: SignalTypeRegistry
): InternalPublishBody | undefined {
  const address = parseChannelAddress(channel);
  if (address === null) {
    return undefined;
  }
  const schema = lookupSignalSchema(registry, address.kind, signal.type);
  const data = schema?.safeParse(signal.data);
  if (!data?.success) {
    return undefined;
  }
  const body = internalPublishBodySchema.safeParse({
    channel,
    type: signal.type,
    data: data.data,
  });
  return body.success ? body.data : undefined;
}

const HTTP_ACCEPTED = 202;

/** Short enough that a caller awaiting it inside a request is not held up by a stalled service. */
export const REALTIME_INTERNAL_CALL_TIMEOUT_MS = 2000;

/** Every failed publish or revoke; ISS-11210's "internal publish failures seen from apps/api" monitor targets it. */
export const REALTIME_INTERNAL_CALL_FAILED_EVENT =
  "realtime.internal_call_failed";
export const REALTIME_INTERNAL_NOT_CONFIGURED_EVENT =
  "realtime.internal_not_configured";
