/**
 * @file outbound-network.ts
 * @description The outbound-network decision vocabulary — which surface asked,
 * what was decided, why, and what class of destination — with the wire
 * sub-schema that carries it.
 *
 * Split out of `schema.ts` (ISS-7429), which sat two logical lines under the
 * 1,000-line `noExcessiveLinesPerFile` ceiling. One bounded vocabulary per
 * module is the shape this directory already uses
 * (`db-host-telemetry-refusal-reason.ts`, `harness-result-envelope-drop-reason.ts`),
 * reached by direct subpath import so no barrel re-export is introduced.
 */

import { z } from "zod";
import { tolerantDesktopTelemetryValue } from "./tolerant-desktop-value";

export const OutboundNetworkSurface = {
  Unknown: "unknown",
  LoopAttachmentDownload: "loop_attachment_download",
  LoopSupportUpload: "loop_support_upload",
  DeployHealthCheck: "deploy_health_check",
} as const;

export type OutboundNetworkSurface =
  (typeof OutboundNetworkSurface)[keyof typeof OutboundNetworkSurface];

export const OutboundNetworkDecision = {
  Unknown: "unknown",
  Allowed: "allowed",
  Denied: "denied",
} as const;

export type OutboundNetworkDecision =
  (typeof OutboundNetworkDecision)[keyof typeof OutboundNetworkDecision];

export const OutboundNetworkDestinationClass = {
  Unknown: "unknown",
  External: "external",
  Invalid: "invalid",
  IpLiteral: "ip_literal",
  LinkLocal: "link_local",
  Loopback: "loopback",
  Metadata: "metadata",
  Private: "private",
  S3PathStyle: "s3_path_style",
  S3VirtualHosted: "s3_virtual_hosted",
} as const;

export type OutboundNetworkDestinationClass =
  (typeof OutboundNetworkDestinationClass)[keyof typeof OutboundNetworkDestinationClass];

export const OutboundNetworkDecisionReason = {
  Unknown: "unknown",
  Allowed: "allowed",
  AttachmentHostNotAllowed: "attachment_host_not_allowed",
  CredentialedUrl: "credentialed_url",
  DeployHostNotAllowed: "deploy_host_not_allowed",
  InvalidUrl: "invalid_url",
  IpLiteralNotAllowed: "ip_literal_not_allowed",
  LinkLocalAddressNotAllowed: "link_local_address_not_allowed",
  MetadataAddressNotAllowed: "metadata_address_not_allowed",
  PathStyleS3NotAllowed: "path_style_s3_not_allowed",
  PrivateAddressNotAllowed: "private_address_not_allowed",
  UnsupportedProtocol: "unsupported_protocol",
} as const;

export type OutboundNetworkDecisionReason =
  (typeof OutboundNetworkDecisionReason)[keyof typeof OutboundNetworkDecisionReason];

export const outboundNetworkDiagnosticsSchema = z.object({
  surface: tolerantDesktopTelemetryValue(OutboundNetworkSurface),
  decision: tolerantDesktopTelemetryValue(OutboundNetworkDecision),
  reason: tolerantDesktopTelemetryValue(OutboundNetworkDecisionReason),
  destinationClass: tolerantDesktopTelemetryValue(
    OutboundNetworkDestinationClass
  ),
  protocol: z.string().optional(),
  hostname: z.string().optional(),
  port: z.string().optional(),
  statusCode: z.number().int().nonnegative().optional(),
});
