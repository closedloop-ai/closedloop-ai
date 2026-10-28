/**
 * One schema for the Socket.IO trust boundary, parsed at BOTH ingresses.
 *
 * The broker and the renderer used to carry separate hand-rolled guards, and
 * they had already drifted: the renderer accepted a manifest of any depth, any
 * entry count and any key length, all of which the broker bounded. Plain ESM
 * with a sibling `.d.mts`, because the dev launcher imports it from Node
 * without a build step and the renderer imports it through Vite.
 */
import { z } from "zod";

export const desktopBrowserBridgeLimits = Object.freeze({
  identifierLength: 128,
  keyLength: 128,
  manifestDepth: 12,
  manifestEntries: 512,
  /**
   * BYTES, and the unit is the whole point. This bound exists to keep a payload
   * under engine.io's `maxHttpBufferSize`, which counts bytes; measuring it in
   * UTF-16 code units instead let three-byte text pass a 2 MiB check at 6 MiB on
   * the wire, and the transport then closed the host socket BEFORE the handler
   * that would have refused it correlatedly could run. Same unit, both ends.
   */
  payloadBytes: 2 * 1024 * 1024,
});

const identifierSchema = z
  .string()
  .min(1)
  .max(desktopBrowserBridgeLimits.identifierLength);
const keySchema = z.string().min(1).max(desktopBrowserBridgeLimits.keyLength);
const argsSchema = z.array(z.unknown());

const manifestSchema = z.lazy(() =>
  z.union([
    z.object({ kind: z.literal("method") }),
    z.object({ kind: z.literal("undefined") }),
    z
      .object({ kind: z.literal("value"), value: z.unknown() })
      .refine((node) => node.value !== undefined),
    z.object({
      entries: z
        .record(keySchema, manifestSchema)
        .refine(
          (entries) =>
            Object.keys(entries).length <=
            desktopBrowserBridgeLimits.manifestEntries
        ),
      kind: z.literal("object"),
    }),
  ])
);

const invokeRequestSchema = z.object({
  args: argsSchema,
  kind: z.literal("invoke"),
  path: z.array(keySchema).min(1).max(desktopBrowserBridgeLimits.manifestDepth),
  requestId: identifierSchema,
});

const invokeRemoteRequestSchema = z.object({
  args: argsSchema,
  kind: z.literal("invoke-remote"),
  remoteFunctionId: identifierSchema,
  requestId: identifierSchema,
});

const requestSchema = z.discriminatedUnion("kind", [
  invokeRequestSchema,
  invokeRemoteRequestSchema,
]);

const hostRequestSchema = z.discriminatedUnion("kind", [
  invokeRequestSchema.extend({ clientId: identifierSchema }),
  invokeRemoteRequestSchema.extend({ clientId: identifierSchema }),
]);

export const bridgeResponseSchema = z.object({
  clientId: identifierSchema,
  error: z
    .object({ message: z.string(), reason: z.string().optional() })
    .optional(),
  requestId: identifierSchema,
  result: z.unknown().optional(),
});

const callbackSchema = z.object({
  args: argsSchema,
  callbackId: identifierSchema,
  clientId: identifierSchema,
});

export function parseBridgeManifest(value) {
  // A manifest nested far past the depth bound blows the stack inside the
  // recursive parse, BEFORE the bound is reached. The broker relays for every
  // client, so that must be a refusal rather than a process exit.
  let parsed;
  try {
    parsed = manifestSchema.safeParse(value);
  } catch {
    return null;
  }
  if (!(parsed.success && isManifestWithinBounds(parsed.data, 0))) {
    return null;
  }
  return parsed.data;
}

export function parseBridgeHostRequest(value) {
  const parsed = hostRequestSchema.safeParse(value);
  if (!(parsed.success && isWithinBridgePayloadLimit(parsed.data.args))) {
    return null;
  }
  return parsed.data;
}

export function parseBridgeResponse(value) {
  const parsed = bridgeResponseSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function parseBridgeCallback(value) {
  const parsed = callbackSchema.safeParse(value);
  if (!parsed.success) {
    return null;
  }
  return parsed.data;
}

export function isWithinBridgePayloadLimit(value) {
  let json;
  try {
    json = JSON.stringify(value);
  } catch {
    return false;
  }
  // `JSON.stringify` answers `undefined` for a bare `undefined` or a function,
  // neither of which is a wire payload this can measure.
  if (typeof json !== "string") {
    return false;
  }
  // A UTF-8 encoding is never SHORTER than the UTF-16 code-unit count, so an
  // over-limit character count is already over the byte limit — which bounds the
  // encode below at twice the limit rather than at the size of the input.
  if (json.length > desktopBrowserBridgeLimits.payloadBytes) {
    return false;
  }
  return (
    payloadEncoder.encode(json).byteLength <=
    desktopBrowserBridgeLimits.payloadBytes
  );
}

/**
 * Depth, entry size and per-node payload size, which the schema itself cannot
 * express: `z.lazy` has no notion of how deep it already is.
 */
function isManifestWithinBounds(node, depth) {
  if (depth > desktopBrowserBridgeLimits.manifestDepth) {
    return false;
  }
  if (node.kind === "value") {
    return isWithinBridgePayloadLimit(node.value);
  }
  if (node.kind !== "object") {
    return true;
  }
  return Object.values(node.entries).every((child) =>
    isManifestWithinBounds(child, depth + 1)
  );
}

const payloadEncoder = new TextEncoder();

export const desktopBrowserBridgeRequestOutcome = Object.freeze({
  Accepted: "accepted",
  Invalid: "invalid",
  TooLarge: "too-large",
});

/**
 * Classify a client request rather than collapse it to `null` (ISS-8413).
 *
 * The broker answers a refusal on the originating `requestId`, and the two
 * refusals are different facts to the caller: a shape it must correct versus a
 * payload it must split. A single `null` could say neither, so the broker had
 * nothing to name and dropped the frame instead.
 */
export function classifyBridgeRequest(value) {
  const parsed = requestSchema.safeParse(value);
  if (!parsed.success) {
    return { outcome: desktopBrowserBridgeRequestOutcome.Invalid };
  }
  if (!isWithinBridgePayloadLimit(parsed.data.args)) {
    return { outcome: desktopBrowserBridgeRequestOutcome.TooLarge };
  }
  return {
    outcome: desktopBrowserBridgeRequestOutcome.Accepted,
    request: parsed.data,
  };
}
