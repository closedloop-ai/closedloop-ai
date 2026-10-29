export const ChannelKind = {
  Comments: "comments",
  Branches: "branches",
  /**
   * Document sync service grants (PLN-2099 E4). Never granted by
   * `/realtime/token` and carries no signals.
   */
  Document: "document",
  /** `document-versions:{orgId}:{documentId}` (PLN-2190): a document's published versions. */
  DocumentVersions: "document-versions",
} as const;
export type ChannelKind = (typeof ChannelKind)[keyof typeof ChannelKind];

export const MAX_CHANNEL_ADDRESS_BYTES = 256;

export const CHANNEL_SEGMENT_SEPARATOR = ":";

export type ParsedChannelAddress = {
  kind: string;
  orgId: string;
  scope: string[];
};

/**
 * Parses `{kind}:{orgId}:{…scope}` for ANY kind that fits the grammar. The
 * service is kind-opaque (PLN-2103 v3), so nothing here may branch on a kind
 * name. Returns null for a malformed address.
 */
export function parseChannelAddress(
  address: string
): ParsedChannelAddress | null {
  if (utf8ByteLength(address) > MAX_CHANNEL_ADDRESS_BYTES) {
    return null;
  }
  const [kind, orgId, ...scope] = address.split(CHANNEL_SEGMENT_SEPARATOR);
  if (kind === undefined || !CHANNEL_KIND_PATTERN.test(kind)) {
    return null;
  }
  if (orgId === undefined || !ORG_ID_PATTERN.test(orgId)) {
    return null;
  }
  if (
    scope.length === 0 ||
    !scope.every((segment) => SCOPE_SEGMENT_PATTERN.test(segment))
  ) {
    return null;
  }
  return { kind, orgId, scope };
}

/** Throws when the result would not parse, so a producer cannot emit a malformed address. */
export function formatChannelAddress(
  kind: ChannelKind,
  orgId: string,
  scope: readonly string[]
): string {
  const address = [kind, orgId, ...scope].join(CHANNEL_SEGMENT_SEPARATOR);
  if (parseChannelAddress(address) === null) {
    throw new Error("Invalid realtime channel address");
  }
  return address;
}

export function utf8ByteLength(value: string): number {
  return UTF8_ENCODER.encode(value).byteLength;
}

export function isChannelOrgId(value: string): boolean {
  return ORG_ID_PATTERN.test(value);
}

const CHANNEL_KIND_PATTERN = /^[a-z][a-z0-9-]{0,31}$/;
// Lowercase only: every channel has exactly one spelling, because two
// spellings of one org would be two different socket.io rooms.
const ORG_ID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const SCOPE_SEGMENT_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const UTF8_ENCODER = new TextEncoder();
