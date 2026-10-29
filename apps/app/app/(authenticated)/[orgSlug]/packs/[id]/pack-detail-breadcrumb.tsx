"use client";

import { useCatalogItem } from "@repo/app/agents/hooks/use-catalog";
import { Header } from "@/app/(authenticated)/components/header";

/** Neutral leaf shown until the pack's name is known (or if it never resolves). */
export const PACK_CRUMB_FALLBACK = "Pack";

/**
 * The detail route's breadcrumb, resolved client-side (ISS-6925).
 *
 * The pack's NAME only exists after the catalog detail read, so the crumb is a
 * client boundary for the same reason the agent-detail crumb is (ISS-5518). It
 * falls back to a neutral leaf rather than echoing the raw id: the id is an
 * opaque identifier the user never typed, and rendering it would read as the
 * pack's name.
 */
export function PackDetailBreadcrumb({
  orgSlug,
  packId,
}: {
  readonly orgSlug: string;
  readonly packId: string;
}) {
  const { data } = useCatalogItem(packId);

  return (
    <Header
      breadcrumbs={[
        { href: `/${orgSlug}/packs`, label: "Packs" },
        { label: data?.name || PACK_CRUMB_FALLBACK },
      ]}
    />
  );
}
