import { DesktopConnectPageShell } from "@repo/app/onboarding/components/desktop-connect-page-shell";
import {
  DesktopConnectStateKind,
  getDesktopConnectStateCopy,
} from "@repo/app/onboarding/lib/desktop-connect-state";
import { Button } from "@repo/design-system/components/ui/button";
import { Link } from "@repo/navigation/link";

/**
 * Bare (no org slug) Desktop connect route.
 *
 * The desktop opens `/settings/integrations/desktop/connect?code=…`. The Clerk
 * middleware (`apps/app/proxy.ts`) rewrites that to `/{orgSlug}/settings/…`
 * whenever the session has an active org. A signed-in user with no active org
 * therefore falls through to this bare path — the `org_required` failure state
 * (FEA-2218): we cannot resolve exactly one internal org, so approval is
 * blocked until the user creates or selects one and reopens the link.
 */
export default function DesktopConnectOrgRequiredPage() {
  const copy = getDesktopConnectStateCopy(DesktopConnectStateKind.OrgRequired);

  return (
    <DesktopConnectPageShell title={copy.title}>
      <p className="text-muted-foreground text-sm">{copy.description}</p>
      <div className="flex justify-end">
        <Button asChild>
          <Link href="/">Set up your organization</Link>
        </Button>
      </div>
    </DesktopConnectPageShell>
  );
}
