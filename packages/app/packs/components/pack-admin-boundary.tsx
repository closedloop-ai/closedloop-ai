"use client";

import {
  Alert,
  AlertDescription,
  AlertTitle,
} from "@repo/design-system/components/ui/alert";
import { Skeleton } from "@repo/design-system/components/ui/skeleton";
import { OctagonAlertIcon, ShieldIcon, UsersRoundIcon } from "lucide-react";
import type { ReactNode } from "react";
import {
  CAPABILITY_HOLDER_LABEL,
  CapabilityHolder,
  PACK_ADMIN_CAPABILITY_META,
  PACK_ADMIN_CAPABILITY_ORDER,
  type PackAdminCapability,
} from "../lib/pack-admin-capability";
import { PageSection } from "./page-section";
import { SourceStatusLine, StatusTone } from "./source-status-line";

// FEA-4084 — the member-vs-admin pack-management boundary, made legible. A
// plain settings-row list (one border, one row per capability), NOT a card
// mosaic: each row states a pack capability, its plain gloss, and who holds it,
// so an admin can see at a glance where the line between member and admin sits.
// The mapping is derived from the app's existing org-role model (see
// `pack-admin-capability`), reused — not a new permissions system. Because pack
// capability follows the Clerk org role, this boundary is read-only by default;
// the editable path only appears where the org model actually permits adjusting
// role assignments (`canManageRoles`), and even then it links out to role
// management rather than inventing an in-place capability toggle.

// The holder audience is a non-color-only signal (icon + words): a shield for
// the admin-gated capabilities, a people glyph for the everyone-held one.
const HOLDER_ICON = {
  [CapabilityHolder.Admins]: ShieldIcon,
  [CapabilityHolder.Everyone]: UsersRoundIcon,
} as const;

const CapabilityRow = ({
  capability,
}: {
  readonly capability: PackAdminCapability;
}) => {
  const meta = PACK_ADMIN_CAPABILITY_META[capability];
  const Icon = HOLDER_ICON[meta.holder];
  return (
    <div className="flex items-center gap-4 px-4 py-3">
      <div className="min-w-0 flex-1">
        <span className="block truncate font-medium text-sm">{meta.label}</span>
        <span className="block truncate text-muted-foreground text-xs">
          {meta.description}
        </span>
      </div>
      <div className="shrink-0">
        <SourceStatusLine
          icon={Icon}
          text={CAPABILITY_HOLDER_LABEL[meta.holder]}
          tone={StatusTone.Muted}
        />
      </div>
    </div>
  );
};

const BoundarySkeleton = () => (
  <div
    className="flex flex-col gap-3"
    data-testid="pack-admin-boundary-skeleton"
  >
    {[0, 1, 2].map((row) => (
      <div className="flex items-center gap-4" key={row}>
        <Skeleton className="h-9 flex-1" />
        <Skeleton className="h-9 w-32" />
      </div>
    ))}
  </div>
);

// A failed read must not silently render an empty boundary — an admin could
// misread "no capabilities" as a real state. Surface the failure honestly.
const BoundaryError = () => (
  <Alert variant="error">
    <OctagonAlertIcon aria-hidden="true" />
    <AlertTitle>Couldn't load pack permissions</AlertTitle>
    <AlertDescription>
      This may be incomplete. Reload the page to try again.
    </AlertDescription>
  </Alert>
);

export type PackAdminBoundaryProps = {
  readonly isLoading?: boolean;
  readonly error?: Error | null;
  /**
   * Whether the viewer may adjust who holds admin pack capabilities. Only true
   * where the org model actually exposes role management; when false (the
   * default), the boundary is read-only — it reports the derived mapping
   * without pretending an editable control that doesn't exist.
   */
  readonly canManageRoles?: boolean;
  /**
   * Action rendered in the section header when {@link canManageRoles} is true —
   * typically a link out to org role management (this surface does not own a
   * permissions system, so it never edits roles in place).
   */
  readonly manageAction?: ReactNode;
};

export const PackAdminBoundary = ({
  isLoading = false,
  error = null,
  canManageRoles = false,
  manageAction,
}: PackAdminBoundaryProps) => {
  const body = () => {
    if (isLoading) {
      return <BoundarySkeleton />;
    }
    if (error) {
      return <BoundaryError />;
    }
    return (
      <div className="flex flex-col divide-y divide-border rounded-lg border border-border">
        {PACK_ADMIN_CAPABILITY_ORDER.map((capability) => (
          <CapabilityRow capability={capability} key={capability} />
        ))}
      </div>
    );
  };

  return (
    <PageSection
      action={canManageRoles ? manageAction : undefined}
      description="Who can author the catalog, distribute packs, and install to their own machines."
      title="Pack permissions"
    >
      {body()}
    </PageSection>
  );
};
