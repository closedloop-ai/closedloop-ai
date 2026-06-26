import { randomBytes } from "node:crypto";

type EcsTaskMetadata = {
  TaskARN: string;
  [key: string]: unknown;
};

async function resolveInstanceId(): Promise<string> {
  if (process.env.RELAY_INSTANCE_ID) {
    return process.env.RELAY_INSTANCE_ID;
  }

  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    try {
      const response = await fetch(`${metadataUri}/task`);
      if (response.ok) {
        const metadata = (await response.json()) as EcsTaskMetadata;
        const taskId = metadata.TaskARN.split("/").pop();
        if (taskId) {
          return taskId;
        }
      }
    } catch {
      // Fall through to random ID
    }
  }

  return `local-${randomBytes(4).toString("hex")}`;
}

const IPV4_RE = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/;

// True only for RFC1918 private IPv4 addresses (10/8, 172.16/12, 192.168/16).
// Loopback (127/8), link-local (169.254/16), public, and malformed addresses
// all return false. Used to validate that a relay advertises a routable
// in-VPC address peers can actually reach.
function isRoutablePrivateIpv4(ip: string): boolean {
  const match = IPV4_RE.exec(ip);
  if (!match) {
    return false;
  }
  const octets = match.slice(1).map(Number);
  if (octets.some((octet) => octet > 255)) {
    return false;
  }
  const [a, b] = octets;
  if (a === 10) {
    return true;
  }
  if (a === 172 && b >= 16 && b <= 31) {
    return true;
  }
  return a === 192 && b === 168;
}

// Resolves the relay's routable private IP from ECS task metadata. Returns null
// — never a loopback fallback — when no routable private IP is available, so the
// caller degrades to in-memory mode rather than publishing an unreachable
// address into the shared registry.
async function resolvePrivateIp(): Promise<string | null> {
  const metadataUri = process.env.ECS_CONTAINER_METADATA_URI_V4;
  if (metadataUri) {
    try {
      const response = await fetch(metadataUri);
      if (response.ok) {
        const metadata = (await response.json()) as {
          Networks?: Array<{ IPv4Addresses?: string[] }>;
        };
        const ip = metadata.Networks?.[0]?.IPv4Addresses?.[0];
        if (ip && isRoutablePrivateIpv4(ip)) {
          return ip;
        }
      }
    } catch {
      // Fall through
    }
  }
  return null;
}

export { isRoutablePrivateIpv4, resolveInstanceId, resolvePrivateIp };
