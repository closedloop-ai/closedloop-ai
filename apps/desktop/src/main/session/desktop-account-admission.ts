import type { SignedInUserIdentity } from "../util/user-identity.js";

/** Immutable account-generation witness carried across asynchronous cloud work. */
export type DesktopAccountAdmission = SignedInUserIdentity & {
  generation: number;
};

/** True only when both witnesses describe the same authenticated account generation. */
export function isSameDesktopAccountAdmission(
  left: DesktopAccountAdmission | null,
  right: DesktopAccountAdmission | null
): boolean {
  return (
    left !== null &&
    right !== null &&
    left.generation === right.generation &&
    left.userId === right.userId &&
    left.organizationId === right.organizationId
  );
}
