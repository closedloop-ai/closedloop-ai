import { RealtimeStatus } from "@repo/realtime-client/port";
import {
  MAX_CHANNEL_ADDRESS_BYTES,
  utf8ByteLength,
} from "@repo/realtime-contract/channels";
import { realtimeErrorCodeSchema } from "@repo/realtime-contract/error-codes";
import { signalPayloadSchema } from "@repo/realtime-contract/protocol";
import { z } from "zod";

/**
 * PLN-2162 M4: what crosses IPC between the main process's realtime host and
 * the renderer's port. Both ends validate, and a payload that fails is dropped.
 */
const channelSchema = z
  .string()
  .min(1)
  .refine((channel) => utf8ByteLength(channel) <= MAX_CHANNEL_ADDRESS_BYTES);

/** `realtime:join` and `realtime:leave` both name one channel. */
export const desktopRealtimeChannelRequestSchema = z.object({
  channel: channelSchema,
});
export type DesktopRealtimeChannelRequest = z.infer<
  typeof desktopRealtimeChannelRequestSchema
>;

const realtimeStatusSchema = z.enum(RealtimeStatus);

/**
 * `realtime:join`'s answer: the socket's status, and whether the channel is
 * already joined on it, so a second consumer of a joined channel is live at
 * once.
 */
export const desktopRealtimeJoinResultSchema = z.object({
  status: realtimeStatusSchema,
  joined: z.boolean(),
});
export type DesktopRealtimeJoinResult = z.infer<
  typeof desktopRealtimeJoinResultSchema
>;

export const DesktopRealtimeEventKind = {
  Signal: "signal",
  Resync: "resync",
  /** The service acknowledged the join; the channel is live while the status is `open`. */
  Joined: "joined",
  /** The channel was refused or revoked and is no longer held. */
  Error: "error",
  Status: "status",
} as const;
export type DesktopRealtimeEventKind =
  (typeof DesktopRealtimeEventKind)[keyof typeof DesktopRealtimeEventKind];

export const desktopRealtimeEventSchema = z.discriminatedUnion("event", [
  z.object({
    event: z.literal(DesktopRealtimeEventKind.Signal),
    channel: channelSchema,
    signal: signalPayloadSchema.omit({ channel: true }),
  }),
  z.object({
    event: z.literal(DesktopRealtimeEventKind.Resync),
    channel: channelSchema,
  }),
  z.object({
    event: z.literal(DesktopRealtimeEventKind.Joined),
    channel: channelSchema,
  }),
  z.object({
    event: z.literal(DesktopRealtimeEventKind.Error),
    channel: channelSchema,
    code: realtimeErrorCodeSchema,
  }),
  z.object({
    event: z.literal(DesktopRealtimeEventKind.Status),
    status: realtimeStatusSchema,
  }),
]);
export type DesktopRealtimeEvent = z.infer<typeof desktopRealtimeEventSchema>;

/**
 * `window.desktopApi.realtime`. Optional on the renderer's side: a preload
 * that predates it leaves the renderer polling.
 */
export type DesktopRealtimeApi = {
  join: (request: DesktopRealtimeChannelRequest) => Promise<unknown>;
  leave: (request: DesktopRealtimeChannelRequest) => Promise<unknown>;
  /** Each payload is unvalidated; returns the unsubscribe. */
  onEvent: (callback: (event: unknown) => void) => () => void;
};
