import { z } from "zod";
import {
  isChannelOrgId,
  parseChannelAddress,
  utf8ByteLength,
} from "./channels";
import { MAX_SIGNAL_PAYLOAD_BYTES, SIGNAL_TYPE_PATTERN } from "./signal";

/**
 * The service-to-service surface of the realtime service (PLN-2105 decisions
 * 4 and 5): `apps/api` calls the internal endpoints through
 * `@repo/realtime-server`, and the receiving instance relays the request to
 * every instance over the Redis bus.
 */
export const RealtimeInternalPath = {
  Publish: "/internal/publish",
  Revoke: "/internal/revoke",
} as const;
export type RealtimeInternalPath =
  (typeof RealtimeInternalPath)[keyof typeof RealtimeInternalPath];

/** The one Redis pub/sub channel every instance subscribes to. */
export const REALTIME_BUS_CHANNEL = "rt:bus";

const channelAddressSchema = z
  .string()
  .refine((address) => parseChannelAddress(address) !== null);

const publishFieldsSchema = z.object({
  channel: channelAddressSchema,
  type: z.string().regex(SIGNAL_TYPE_PATTERN),
  data: z.json(),
});

/**
 * `data` is opaque JSON: the per-type schema is checked by the publisher, not
 * the kind-opaque service. The serialized body is held to the signal byte cap.
 */
export const internalPublishBodySchema = publishFieldsSchema.refine(
  (body) => utf8ByteLength(JSON.stringify(body)) <= MAX_SIGNAL_PAYLOAD_BYTES
);
export type InternalPublishBody = z.infer<typeof internalPublishBodySchema>;

/** Exactly one of a user, a channel or an organization. */
export const revokeTargetSchema = z.union([
  z.strictObject({ userId: z.string().min(1) }),
  z.strictObject({ channel: channelAddressSchema }),
  z.strictObject({ orgId: z.string().refine(isChannelOrgId) }),
]);
export type RevokeTarget = z.infer<typeof revokeTargetSchema>;

export const internalRevokeBodySchema = z.object({
  target: revokeTargetSchema,
});
export type InternalRevokeBody = z.infer<typeof internalRevokeBodySchema>;

export const BusOp = {
  Publish: "publish",
  Revoke: "revoke",
} as const;
export type BusOp = (typeof BusOp)[keyof typeof BusOp];

export const busMessageSchema = z.discriminatedUnion("op", [
  publishFieldsSchema.extend({ op: z.literal(BusOp.Publish) }),
  z.object({ op: z.literal(BusOp.Revoke), target: revokeTargetSchema }),
]);
export type BusMessage = z.infer<typeof busMessageSchema>;

/**
 * ISS-11966 item 2: `/internal/*` takes `apps/api`'s Vercel OIDC token minted
 * for a realtime-only audience. Vercel's default audience,
 * `https://vercel.com/<team>`, is the one AWS STS trusts (ISS-11827's signer
 * role pins it), so a token realtime receives must never carry it.
 */
export function isRealtimeOnlyOidcAudience(audience: string): boolean {
  return !audience
    .toLowerCase()
    .startsWith(VERCEL_DEFAULT_OIDC_AUDIENCE_PREFIX);
}

const VERCEL_DEFAULT_OIDC_AUDIENCE_PREFIX = "https://vercel.com/";
