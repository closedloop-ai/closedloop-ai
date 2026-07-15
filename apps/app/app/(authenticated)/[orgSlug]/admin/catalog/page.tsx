import { FeatureFlagged } from "@repo/analytics/components/feature-flagged";
import { AGENTS_FEATURE_FLAG_KEY } from "@repo/app/shared/lib/feature-flags";
import { auth } from "@repo/auth/server";
import type { Metadata } from "next";
import { Header } from "../../../components/header";
import { CatalogDashboard } from "./components/catalog-dashboard";

export const metadata: Metadata = {
  title: "Packs",
  description:
    "Author and distribute Packs — bundles of skills, commands, agents, hooks, plugins, and MCPs for your org",
};

type PageProps = {
  readonly params: Promise<{ orgSlug: string }>;
};

/**
 * Catalog dashboard (T-17.1 / AC-023).
 *
 * Server-side role lookup drives capability flags in the client dashboard:
 * admins manage catalog/distribution controls, while members can browse the
 * catalog and edit their own existing org-custom items. The page itself is
 * gated behind AGENTS_FEATURE_FLAG_KEY so it ships dark alongside the rest of
 * the feature.
 */
export default async function CatalogAdminPage({ params }: PageProps) {
  const [{ has }, { orgSlug }] = await Promise.all([auth(), params]);

  const isAdmin = has({ role: "org:admin" }) || has({ role: "org:owner" });

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <Header
        breadcrumbs={[
          { label: "Agents", href: `/${orgSlug}/agents` },
          { label: "Packs" },
        ]}
      />
      <FeatureFlagged flag={AGENTS_FEATURE_FLAG_KEY}>
        <main className="flex min-h-0 flex-1 flex-col gap-4 overflow-auto p-4 pt-0">
          <CatalogDashboard isAdmin={isAdmin} />
        </main>
      </FeatureFlagged>
    </div>
  );
}
