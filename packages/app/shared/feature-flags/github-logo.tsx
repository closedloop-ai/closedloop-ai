"use client";

import { GitHubMark } from "@repo/design-system/components/ui/brand-icons";
import { Github } from "lucide-react";
import type { SVGProps } from "react";
import { useIsMounted } from "../hooks/use-is-mounted";
import { GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY } from "../lib/feature-flags";
import { useFeatureFlagEnabledOptional } from "./use-feature-flag-enabled";

/**
 * The GitHub logo for every shared and `apps/app` surface, gated on
 * {@link GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY} (FEA-3570). Enabled it is
 * the filled Invertocat mark; closed or unresolved it is the lucide outline
 * glyph these surfaces render today.
 *
 * Forwards every SVG prop, so the existing `size-4`/`size-6` classes still size
 * whichever mark renders. Not a drop-in for labelling: lucide drops its own
 * `aria-hidden` as soon as it sees any `aria-*` prop, while `GitHubMark` keeps
 * it unless the caller also passes `aria-hidden={false}`. No call site labels
 * the mark today — every one of them sits inside an already-labelled control.
 *
 * The OPTIONAL adapter read, rather than the throwing one, because these
 * components also mount under Storybook and mini-table tests, which wrap no
 * `FeatureFlagAdapterProvider`; there the gate reads closed and the outline
 * renders rather than the subtree crashing.
 *
 * Gated on having mounted so the closed state is byte-identical to today's
 * markup: PostHog can answer from bootstrapped local state on the first client
 * render, so reading the flag during hydration would let the first client paint
 * disagree with the server HTML. Enabled viewers get the swap on the render
 * after mount instead.
 */
export function GitHubLogo(props: SVGProps<SVGSVGElement>) {
  const filled = useFeatureFlagEnabledOptional(
    GITHUB_BRAND_MARK_FILLED_FEATURE_FLAG_KEY
  );
  const mounted = useIsMounted();

  return mounted && filled ? <GitHubMark {...props} /> : <Github {...props} />;
}
