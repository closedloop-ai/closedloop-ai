import { GrantAccess } from "@repo/realtime-contract/grants";
import { signalRuntime } from "../signal/runtime";
import type { DeliveryClassModule } from "./registry";

/**
 * The signal class's limits (PLN-2104 decision 1 and step 6). ISS-11211 AC 9
 * requires them recorded here; ISS-11210's load test tunes them.
 */
export const SIGNAL_MAX_PACKET_BYTES = 16 * 1024;
export const SIGNAL_MAX_CHANNELS_PER_CONNECTION = 100;
/**
 * The burst covers a reconnect rejoining every channel at once, plus a
 * refresh; the refill is the sustained event rate one connection may keep up.
 */
export const SIGNAL_MESSAGE_BURST = SIGNAL_MAX_CHANNELS_PER_CONNECTION + 20;
export const SIGNAL_MESSAGE_REFILL_PER_SECOND = 10;
/**
 * Operator decision 2026-09-30 (PR #8191): a connection the bucket refuses
 * this many events within the window is disconnected. Reaching it takes
 * sending at twice the sustained rate for the whole window once the burst is
 * spent. A reconnect's rejoin fits inside the burst and is never refused.
 */
export const SIGNAL_FLOOD_MAX_REFUSALS = 100;
export const SIGNAL_FLOOD_WINDOW_MS = 10_000;
/**
 * Packets the engine may hold unsent for one socket. A healthy socket holds
 * none between ticks; a single tick's fan-out (a resync across every channel)
 * stays well under it.
 */
export const SIGNAL_MAX_BUFFERED_PACKETS =
  10 * SIGNAL_MAX_CHANNELS_PER_CONNECTION;

export const signalClass: DeliveryClassModule = {
  subscribeAccess: GrantAccess.Read,
  clientPublish: false,
  serverPublish: true,
  limits: {
    maxPacketBytes: SIGNAL_MAX_PACKET_BYTES,
    maxChannelsPerConnection: SIGNAL_MAX_CHANNELS_PER_CONNECTION,
    messageRate: {
      burst: SIGNAL_MESSAGE_BURST,
      refillPerSecond: SIGNAL_MESSAGE_REFILL_PER_SECOND,
    },
    flood: {
      maxRefusals: SIGNAL_FLOOD_MAX_REFUSALS,
      windowMs: SIGNAL_FLOOD_WINDOW_MS,
    },
    maxBufferedPackets: SIGNAL_MAX_BUFFERED_PACKETS,
  },
  runtime: signalRuntime,
};
