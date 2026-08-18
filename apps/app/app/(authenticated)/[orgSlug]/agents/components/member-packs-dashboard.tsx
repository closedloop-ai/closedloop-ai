"use client";

import { MemberView } from "@repo/app/packs/components/member-view";
import { useAdminPackViews } from "@repo/app/packs/hooks/use-admin-pack-views";

/**
 * Member-facing Packs workspace for the web Agents → Plugins tab (FEA-4089).
 *
 * Regroups the member view by *source*: a primary "Your packs" table grouped
 * into Required (org `auto_install`, non-removable) and Installed (each row
 * carrying its honest provenance — auto-installed / opted-in / self), and a
 * secondary "Available" catalog list. Source is derived from the real
 * `DistributionMode` via the canonical {@link InstallSource} contract
 * (FEA-4090) — never a hand-rolled source string — and a required pack whose
 * push failed on this member's machine is shown as an honest strand row rather
 * than a silent absence.
 *
 * Data: the org catalog + distributions folded into `PackView`s. `GET
 * /distributions` is org-visible (no admin gate — `read` scope), so a member
 * can read the distribution linkage that drives the Required/Installed
 * grouping. Actually installing/uninstalling from the web is deferred to a
 * member-scoped dispatch path (FEA-4071 / FEA-4082); this slice is the
 * by-source treatment + source honesty.
 */
export function MemberPacksDashboard() {
  const { packViews, isLoading, error } = useAdminPackViews({
    includeDistributions: true,
  });

  // The heading is static — known before the catalog resolves — so it renders
  // above every state (loading / error / empty / populated) rather than popping
  // in and pushing the regions down on load.
  const heading = (
    <div>
      <h2 className="font-semibold text-lg">Plugins</h2>
      <p className="text-muted-foreground text-sm">
        Browse the Packs available to your organization.
      </p>
    </div>
  );

  return (
    <MemberView
      error={error}
      headerSlot={heading}
      isLoading={isLoading}
      packs={packViews}
    />
  );
}
