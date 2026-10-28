import type { z } from "zod";

export const desktopBrowserBridgeLimits: Readonly<{
  identifierLength: 128;
  keyLength: 128;
  manifestDepth: 12;
  manifestEntries: 512;
  /** UTF-8 BYTES, the same unit engine.io's `maxHttpBufferSize` counts. */
  payloadBytes: number;
}>;

export type BridgeManifestNode =
  | { kind: "method" }
  | { kind: "object"; entries: Record<string, BridgeManifestNode> }
  | { kind: "undefined" }
  | { kind: "value"; value: unknown };

export type BridgeInvocation =
  | { args: unknown[]; kind: "invoke"; path: string[] }
  | { args: unknown[]; kind: "invoke-remote"; remoteFunctionId: string };

export type BridgeRequest = BridgeInvocation & { requestId: string };

export type BridgeHostRequest = BridgeRequest & { clientId: string };

export type BridgeResponse = {
  clientId: string;
  error?: { message: string; reason?: string };
  requestId: string;
  result?: unknown;
};

export type BridgeCallbackMessage = {
  args: unknown[];
  callbackId: string;
  clientId: string;
};

export const bridgeResponseSchema: z.ZodObject<{
  clientId: z.ZodTypeAny;
  error: z.ZodTypeAny;
  requestId: z.ZodTypeAny;
  result: z.ZodTypeAny;
}>;

export function parseBridgeManifest(value: unknown): BridgeManifestNode | null;
export function parseBridgeHostRequest(
  value: unknown
): BridgeHostRequest | null;
export function parseBridgeResponse(value: unknown): BridgeResponse | null;
export function parseBridgeCallback(
  value: unknown
): BridgeCallbackMessage | null;
export function isWithinBridgePayloadLimit(value: unknown): boolean;

export const desktopBrowserBridgeRequestOutcome: Readonly<{
  Accepted: "accepted";
  Invalid: "invalid";
  TooLarge: "too-large";
}>;

export type DesktopBrowserBridgeRequestOutcome =
  (typeof desktopBrowserBridgeRequestOutcome)[keyof typeof desktopBrowserBridgeRequestOutcome];

export type BridgeRequestClassification =
  | { outcome: "accepted"; request: BridgeRequest }
  | { outcome: "invalid" }
  | { outcome: "too-large" };

export function classifyBridgeRequest(
  value: unknown
): BridgeRequestClassification;
