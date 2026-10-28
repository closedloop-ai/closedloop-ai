"use client";

import { useFeatureFlag } from "@repo/analytics/client";
import { GITHUB_BRAND_MARK_FILLED_FLAG_KEY } from "@repo/api/src/types/github-brand-mark-filled-flag";
import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import { Github } from "lucide-react";
import { type SVGProps, useEffect, useState } from "react";

/**
 * The GitHub logo for the marketing site, gated on the same PostHog key the
 * product surfaces read (FEA-3570). Enabled it is the filled Invertocat mark;
 * closed or unresolved it is the lucide outline glyph shipping today.
 *
 * A client component so four SERVER call sites (the header, footer, hero, and
 * the `/docs` site links) can gate a single icon without themselves becoming
 * client components. It forwards every SVG prop, so the existing `size-4` /
 * `size-5` classes still size whichever mark renders; the `aria-label`s live on
 * the surrounding links and are untouched either way.
 *
 * `apps/web` reads the flag through `@repo/analytics/client` rather than the
 * `@repo/app` adapter port: this app mounts `AnalyticsProvider` but no
 * `FeatureFlagAdapterProvider`, and does not depend on `@repo/app` at all. Both
 * readers resolve the one literal above, which is what keeps the marketing site
 * and the product from disagreeing about the mark.
 *
 * Gated on having mounted for the reason the product component documents: the
 * closed state must be byte-identical to today's server-rendered markup, and
 * PostHog can answer from bootstrapped local state on the first client render.
 */
export function GitHubLogo(props: SVGProps<SVGSVGElement>) {
  const [mounted, setMounted] = useState(false);
  const filled = useFeatureFlag(GITHUB_BRAND_MARK_FILLED_FLAG_KEY)?.enabled;

  useEffect(() => {
    setMounted(true);
  }, []);

  return mounted && filled ? <GitHubMark {...props} /> : <Github {...props} />;
}
