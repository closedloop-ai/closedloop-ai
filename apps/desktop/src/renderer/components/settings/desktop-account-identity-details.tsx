import { getUserNamePart } from "@repo/app/shared/lib/user-utils";
import type { DesktopIdentity } from "../../types/desktop-api";

/**
 * Who an account is — name, email, organization. The sign-in account
 * confirmation (ISS-11345) mounts it so the account a user is asked to confirm
 * reads with its full identity.
 */
export function IdentityDetails({
  identity,
  userId,
  organizationId,
}: {
  identity: DesktopIdentity | null;
  userId: string | null;
  organizationId: string | null;
}) {
  const fullName = identity ? getUserNamePart(identity) : "";
  // Prefer name, then email, then the raw id so the row is never blank.
  const userValue = fullName || identity?.email || userId || "—";
  const userSecondary = fullName && identity?.email ? identity.email : null;
  const organizationValue = identity?.organizationName || organizationId || "—";
  return (
    <>
      <IdentityRow label="User" secondary={userSecondary} value={userValue} />
      <IdentityRow label="Organization" value={organizationValue} />
    </>
  );
}

function IdentityRow({
  label,
  value,
  secondary,
}: {
  label: string;
  value: string;
  secondary?: string | null;
}) {
  return (
    <div className="flex items-start gap-3 text-sm">
      <span className="w-24 shrink-0 pt-0.5 text-[var(--muted-foreground)]">
        {label}
      </span>
      <div className="min-w-0">
        <p className="truncate text-[var(--foreground)]">{value}</p>
        {secondary ? (
          <p className="truncate text-[var(--muted-foreground)] text-xs">
            {secondary}
          </p>
        ) : null}
      </div>
    </div>
  );
}
