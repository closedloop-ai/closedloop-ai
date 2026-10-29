"use client";

import { startPollLoop } from "@repo/realtime-client/poll";
import type {
  RealtimeChannelListener,
  RealtimeSignal,
} from "@repo/realtime-client/port";
import { useEffect, useRef } from "react";
import type { z } from "zod";
import { useRealtimeClient } from "./realtime-provider";

/** One channel kind's signal schemas, as `SignalTypes[kind]` in `@repo/realtime-contract/signals`. */
export type SignalTypeSchemas = Readonly<Record<string, z.ZodType>>;

export type TypedSignal<Types extends SignalTypeSchemas> = {
  [Type in keyof Types & string]: { type: Type; data: z.output<Types[Type]> };
}[keyof Types & string];

type SignalsCallbacks = {
  onResync: () => void;
  /** See `RealtimeChannelListener.dataLoadedAt`. */
  dataLoadedAt?: () => number | undefined;
  /** Runs only while the channel is not live; with no client mounted, always. */
  poll?: () => Promise<void>;
  /** See `RealtimeChannelListener.onError`. */
  onError?: RealtimeChannelListener["onError"];
  /** See `RealtimeChannelListener.onPollError`. */
  onPollError?: RealtimeChannelListener["onPollError"];
};

export type UntypedSignalsOptions = SignalsCallbacks & {
  onSignal: (signal: RealtimeSignal) => void;
  types?: undefined;
};

export type TypedSignalsOptions<Types extends SignalTypeSchemas> =
  SignalsCallbacks & {
    onSignal: (signal: TypedSignal<Types>) => void;
    /** A signal whose type is missing here, or whose data fails its schema, is skipped (PLN-2106 decision 7). */
    types: Types;
    /**
     * A signal of a type listed in `types` whose data failed that type's
     * schema, which is skipped. A type missing from `types` is version skew
     * and is never reported here.
     */
    onInvalidSignal?: (signal: RealtimeSignal, error: z.ZodError) => void;
  };

/**
 * PLN-2106 step 6. Joins `channel` on mount and leaves on unmount; the
 * callbacks, `poll` included, are read at call time, so a new identity or
 * `poll` coming and going never rejoins. With no client mounted, or no
 * channel to join yet (`null`), it only polls.
 */
export function useSignals<Types extends SignalTypeSchemas>(
  channel: string | null,
  options: TypedSignalsOptions<Types>
): void;
export function useSignals(
  channel: string | null,
  options: UntypedSignalsOptions
): void;
export function useSignals(
  channel: string | null,
  options: TypedSignalsOptions<SignalTypeSchemas> | UntypedSignalsOptions
): void {
  const client = useRealtimeClient();
  const latest = useRef(options);
  useEffect(() => {
    latest.current = options;
  });

  useEffect(() => {
    const poll = () => latest.current.poll?.() ?? Promise.resolve();
    const onPollError = (error: unknown) => latest.current.onPollError?.(error);
    if (client === null || channel === null) {
      const loop = startPollLoop({ poll, onError: onPollError, live: false });
      return () => loop.stop();
    }
    return client.join(channel, {
      onSignal: (signal) => deliver(latest.current, signal),
      onResync: () => latest.current.onResync(),
      onError: (code) => latest.current.onError?.(code),
      dataLoadedAt: () => latest.current.dataLoadedAt?.(),
      poll,
      onPollError,
    });
  }, [client, channel]);
}

function deliver(
  options: TypedSignalsOptions<SignalTypeSchemas> | UntypedSignalsOptions,
  signal: RealtimeSignal
): void {
  if (options.types === undefined) {
    options.onSignal(signal);
    return;
  }
  // Own keys only: a type named like an Object.prototype member is unknown.
  const schema = Object.hasOwn(options.types, signal.type)
    ? options.types[signal.type]
    : undefined;
  if (schema === undefined) {
    return;
  }
  const parsed = schema.safeParse(signal.data);
  if (parsed.success) {
    options.onSignal({ type: signal.type, data: parsed.data });
  } else {
    options.onInvalidSignal?.(signal, parsed.error);
  }
}
