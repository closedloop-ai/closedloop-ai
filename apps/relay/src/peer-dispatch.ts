import type { IncomingMessage, ServerResponse } from "node:http";
import {
  RelayDispatchDiagnosticReason,
  relayDispatchNotDelivered,
} from "@repo/api/src/types/relay-dispatch";
import { log } from "@repo/observability/log";
import { parseDispatchBody, validateSecret } from "./dispatch.js";
import { jsonResponse } from "./http-io.js";
import { isRoutablePrivateIpv4 } from "./instance-discovery.js";
import { RELAY_PORT } from "./relay-env.js";
import type { InstanceInfo } from "./target-registry.js";
import { workersByTargetId } from "./worker-registry.js";

const RELAY_INTERNAL_ALLOWED_IPS = (
  process.env.RELAY_INTERNAL_ALLOWED_IPS ?? ""
)
  .split(",")
  .map((v) => v.trim())
  .filter(Boolean);

export async function handleInternalDispatch(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  if (!validateSecret(req.headers["x-internal-secret"])) {
    jsonResponse(res, 401, { error: "Unauthorized" });
    return;
  }

  // The timing-safe shared secret (validateSecret, above) is the security
  // boundary for this endpoint. The CIDR allowlist is optional defense-in-depth
  // for deployments that want to additionally restrict source IPs to the VPC.
  // When unset, the secret alone authorizes — a localhost-only fallback would
  // be wrong here, since legitimate cross-instance proxy traffic originates
  // from peer relays' private IPs, never loopback.
  if (RELAY_INTERNAL_ALLOWED_IPS.length > 0) {
    const sourceIp = req.socket.remoteAddress ?? "";
    const allowed = RELAY_INTERNAL_ALLOWED_IPS.some((cidr) =>
      isAddressInCidr(sourceIp, cidr)
    );
    if (!allowed) {
      jsonResponse(res, 403, { error: "Forbidden" });
      return;
    }
  }

  // ISS-8673: a hop the sender abandons at PEER_DISPATCH_TIMEOUT_MS is recorded
  // only on the sending side (proxy-dispatch.ts:121), and that record cannot say
  // whether the request ever landed here — so "never arrived" and "arrived and
  // did not answer in time" were indistinguishable in production. This is the
  // receiving half of that pair.
  //
  // Emitted before the body is read, deliberately: the sender's abort destroys
  // the socket, so `parseDispatchBody` may never resolve, and a record placed
  // after it would be missing for exactly the timed-out case it exists to
  // explain. Nothing parsed from the body is available this early, which is why
  // this carries no targetId — the question it answers is arrival, and the
  // comparison that answers it is against the sender's failure count.
  log.info("Internal dispatch received", {
    sourceIp: req.socket.remoteAddress ?? "",
  });

  const payload = await parseDispatchBody(req, res);
  if (!payload) {
    return;
  }

  const { targetId, operation } = payload;
  const worker = workersByTargetId.get(targetId);
  if (!worker) {
    jsonResponse(
      res,
      200,
      relayDispatchNotDelivered(RelayDispatchDiagnosticReason.PeerNoWorker)
    );
    return;
  }

  worker.socket.emit("desktop.command", operation);
  jsonResponse(res, 200, { delivered: true });
}

const IPV6_MAPPED_RE = /^::ffff:/;

export function isAddressInCidr(address: string, cidr: string): boolean {
  const [subnet, bits] = cidr.split("/");
  if (!(subnet && bits)) {
    return address === cidr;
  }
  const prefixLen = Number(bits);
  // Fail closed on malformed or out-of-range prefixes (e.g. "/foo", "/-1",
  // "/40"). A malformed allowlist entry must never match every address.
  // Mirrors the MCP counterpart in apps/mcp/src/index.ts.
  if (!Number.isInteger(prefixLen) || prefixLen < 0 || prefixLen > 32) {
    return false;
  }
  // "/0" legitimately matches all addresses. Handle it explicitly: the mask
  // computation below would shift by 32, which JS evaluates as a shift by 0
  // (1 << 32 === 1), producing a full mask instead of an empty one.
  if (prefixLen === 0) {
    return true;
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: IP address mask computation requires bitwise ops
  const mask = ~((1 << (32 - prefixLen)) - 1) >>> 0;
  const ipNum = ipToNumber(address.replace(IPV6_MAPPED_RE, ""));
  const subnetNum = ipToNumber(subnet);
  // biome-ignore lint/suspicious/noBitwiseOperators: IP subnet matching requires bitwise AND
  return (ipNum & mask) === (subnetNum & mask);
}

function ipToNumber(ip: string): number {
  let result = 0;
  for (const octet of ip.split(".")) {
    // biome-ignore lint/suspicious/noBitwiseOperators: packing IPv4 octets into a 32-bit integer
    result = (result << 8) + Number(octet);
  }
  // biome-ignore lint/suspicious/noBitwiseOperators: unsigned 32-bit conversion
  return result >>> 0;
}

// Egress allowlist for cross-instance dispatch. The peer address comes from the
// Redis registry, so it is untrusted: validate it before sending the internal
// secret. The port must match this deployment's relay port (every relay task
// listens on the same port), and the IP must be either inside the configured
// CIDR allowlist or — when none is configured — an RFC1918 private address.
export function isAllowedPeerInstance(info: InstanceInfo): boolean {
  if (typeof info.privateIp !== "string" || !Number.isInteger(info.port)) {
    return false;
  }
  if (info.port !== RELAY_PORT) {
    return false;
  }
  if (RELAY_INTERNAL_ALLOWED_IPS.length > 0) {
    return RELAY_INTERNAL_ALLOWED_IPS.some((cidr) =>
      isAddressInCidr(info.privateIp, cidr)
    );
  }
  return isRoutablePrivateIpv4(info.privateIp);
}
