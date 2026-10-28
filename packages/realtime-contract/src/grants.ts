import { z } from "zod";
import { CHANNEL_SEGMENT_SEPARATOR, parseChannelAddress } from "./channels";

export const GrantAccess = {
  Read: "read",
  Write: "write",
} as const;
export type GrantAccess = (typeof GrantAccess)[keyof typeof GrantAccess];

export const GRANT_WILDCARD = "*";

export const grantSchema = z.object({
  pattern: z.string().min(1),
  access: z.enum([GrantAccess.Read, GrantAccess.Write]),
});
export type Grant = z.infer<typeof grantSchema>;

/**
 * True when some grant covers `address` at `access` or higher (`write`
 * implies `read`). `*` matches exactly one segment and only in the final
 * position. The address's org segment must equal `tokenOrg`, whatever the
 * grants say, so a grant can never reach into another organization.
 */
export function matchGrant(
  grants: readonly Grant[],
  address: string,
  access: GrantAccess,
  tokenOrg: string
): boolean {
  const parsed = parseChannelAddress(address);
  if (parsed === null || parsed.orgId !== tokenOrg) {
    return false;
  }
  const addressSegments = [parsed.kind, parsed.orgId, ...parsed.scope];
  return grants.some(
    (grant) =>
      ACCESS_RANK[grant.access] >= ACCESS_RANK[access] &&
      patternMatches(grant.pattern, addressSegments)
  );
}

const ACCESS_RANK: Record<GrantAccess, number> = {
  [GrantAccess.Read]: 1,
  [GrantAccess.Write]: 2,
};

function patternMatches(
  pattern: string,
  addressSegments: readonly string[]
): boolean {
  const patternSegments = pattern.split(CHANNEL_SEGMENT_SEPARATOR);
  if (patternSegments.length !== addressSegments.length) {
    return false;
  }
  const lastIndex = patternSegments.length - 1;
  return patternSegments.every(
    (segment, index) =>
      (segment === GRANT_WILDCARD && index === lastIndex) ||
      (segment !== GRANT_WILDCARD && segment === addressSegments[index])
  );
}
