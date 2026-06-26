import net from "node:net";
import type {
  OutboundNetworkDecisionReason,
  OutboundNetworkDestinationClass,
  OutboundNetworkDiagnostics,
  OutboundNetworkSurface,
} from "../main/telemetry-protocol.js";

const S3_VIRTUAL_HOSTED_HOST_RE =
  /^[a-z0-9][a-z0-9.-]*\.s3\.[a-z0-9-]+\.amazonaws\.com$/;
const S3_PATH_STYLE_HOST_RE = /^s3(?:[.-][a-z0-9-]+)?\.amazonaws\.com$/;
const BRACKETED_IPV6_HOST_RE = /^\[(.*)]$/;

export type OutboundUrlPolicyDecision =
  | {
      allowed: true;
      diagnostics: OutboundNetworkDiagnostics;
    }
  | {
      allowed: false;
      diagnostics: OutboundNetworkDiagnostics;
    };

/**
 * Validates an outbound URL for a specific Desktop fetch surface before any
 * network I/O. Decisions intentionally expose only parsed descriptor fields so
 * callers cannot log signed URL paths, query credentials, or object keys.
 */
export function validateOutboundUrlForSurface(
  surface: OutboundNetworkSurface,
  rawUrl: string
): OutboundUrlPolicyDecision {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    return deny(surface, "invalid_url", "invalid", {});
  }

  const descriptor = descriptorFromUrl(parsed);

  if (parsed.username !== "" || parsed.password !== "") {
    return deny(surface, "credentialed_url", "external", descriptor);
  }

  if (
    surface === "loop_attachment_download" ||
    surface === "loop_support_upload"
  ) {
    return validateAttachmentUrl(surface, parsed, descriptor);
  }

  return validateDeployHealthUrl(surface, parsed, descriptor);
}

function validateAttachmentUrl(
  surface: OutboundNetworkSurface,
  parsed: URL,
  descriptor: UrlDescriptor
): OutboundUrlPolicyDecision {
  if (parsed.protocol !== "https:") {
    return deny(surface, "unsupported_protocol", "external", descriptor);
  }

  const hostClass = classifyHostname(parsed.hostname);
  const addressDenyReason = denyReasonForAddressClass(hostClass);
  if (addressDenyReason) {
    return deny(surface, addressDenyReason, hostClass, descriptor);
  }

  const hostname = normalizeHostname(parsed.hostname);
  if (S3_PATH_STYLE_HOST_RE.test(hostname)) {
    return deny(
      surface,
      "path_style_s3_not_allowed",
      "s3_path_style",
      descriptor
    );
  }

  if (!S3_VIRTUAL_HOSTED_HOST_RE.test(hostname)) {
    return deny(surface, "attachment_host_not_allowed", hostClass, descriptor);
  }

  return allow(surface, "s3_virtual_hosted", descriptor);
}

function validateDeployHealthUrl(
  surface: OutboundNetworkSurface,
  parsed: URL,
  descriptor: UrlDescriptor
): OutboundUrlPolicyDecision {
  if (!(parsed.protocol === "http:" || parsed.protocol === "https:")) {
    return deny(surface, "unsupported_protocol", "external", descriptor);
  }

  const hostClass = classifyHostname(parsed.hostname);
  if (hostClass === "loopback") {
    return allow(surface, "loopback", descriptor);
  }

  return deny(
    surface,
    denyReasonForDeployHostClass(hostClass),
    hostClass,
    descriptor
  );
}

type UrlDescriptor = Pick<
  OutboundNetworkDiagnostics,
  "hostname" | "port" | "protocol"
>;

function descriptorFromUrl(parsed: URL): UrlDescriptor {
  return {
    protocol: parsed.protocol,
    hostname: normalizeHostname(parsed.hostname),
    ...(parsed.port !== "" && { port: parsed.port }),
  };
}

function allow(
  surface: OutboundNetworkSurface,
  destinationClass: OutboundNetworkDestinationClass,
  descriptor: UrlDescriptor
): OutboundUrlPolicyDecision {
  return {
    allowed: true,
    diagnostics: {
      surface,
      decision: "allowed",
      reason: "allowed",
      destinationClass,
      ...descriptor,
    },
  };
}

function deny(
  surface: OutboundNetworkSurface,
  reason: OutboundNetworkDecisionReason,
  destinationClass: OutboundNetworkDestinationClass,
  descriptor: UrlDescriptor
): OutboundUrlPolicyDecision {
  return {
    allowed: false,
    diagnostics: {
      surface,
      decision: "denied",
      reason,
      destinationClass,
      ...descriptor,
    },
  };
}

function classifyHostname(hostname: string): OutboundNetworkDestinationClass {
  const normalized = normalizeHostname(hostname);

  if (normalized === "localhost" || normalized.endsWith(".localhost")) {
    return "loopback";
  }

  const ipVersion = net.isIP(normalized);
  if (ipVersion === 4) {
    return classifyIpv4(normalized);
  }
  if (ipVersion === 6) {
    return classifyIpv6(normalized);
  }

  return "external";
}

function classifyIpv4(hostname: string): OutboundNetworkDestinationClass {
  const octets = hostname.split(".").map((part) => Number.parseInt(part, 10));
  const [first, second, third, fourth] = octets;

  if (first === 127) {
    return "loopback";
  }
  if (first === 169 && second === 254 && third === 169 && fourth === 254) {
    return "metadata";
  }
  if (first === 169 && second === 254) {
    return "link_local";
  }
  if (
    first === 10 ||
    (first === 172 && second >= 16 && second <= 31) ||
    (first === 192 && second === 168)
  ) {
    return "private";
  }

  return "ip_literal";
}

function classifyIpv6(hostname: string): OutboundNetworkDestinationClass {
  const lower = hostname.toLowerCase();
  if (lower === "::1" || lower === "0:0:0:0:0:0:0:1") {
    return "loopback";
  }
  if (lower.startsWith("fe8") || lower.startsWith("fe9")) {
    return "link_local";
  }
  if (lower.startsWith("fea") || lower.startsWith("feb")) {
    return "link_local";
  }
  if (lower.startsWith("fc") || lower.startsWith("fd")) {
    return "private";
  }

  return "ip_literal";
}

function denyReasonForAddressClass(
  destinationClass: OutboundNetworkDestinationClass
): OutboundNetworkDecisionReason | null {
  if (destinationClass === "metadata") {
    return "metadata_address_not_allowed";
  }
  if (destinationClass === "private" || destinationClass === "link_local") {
    return destinationClass === "link_local"
      ? "link_local_address_not_allowed"
      : "private_address_not_allowed";
  }
  if (destinationClass === "loopback" || destinationClass === "ip_literal") {
    return "ip_literal_not_allowed";
  }
  return null;
}

function denyReasonForDeployHostClass(
  destinationClass: OutboundNetworkDestinationClass
): OutboundNetworkDecisionReason {
  const addressReason = denyReasonForAddressClass(destinationClass);
  return addressReason ?? "deploy_host_not_allowed";
}

function normalizeHostname(hostname: string): string {
  return hostname.toLowerCase().replace(BRACKETED_IPV6_HOST_RE, "$1");
}
