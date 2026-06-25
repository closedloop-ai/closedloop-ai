"use client";

import type { NavigationLinkProps } from "./navigation-adapter";
import { useNavigationAdapter } from "./provider";

/**
 * Surface-agnostic link. Replaces direct `next/link` usage in shared/feature
 * code; the active adapter supplies the real implementation and must render
 * an actual anchor element.
 */
export function Link(props: NavigationLinkProps) {
  const { Link: AdapterLink } = useNavigationAdapter();
  return <AdapterLink {...props} />;
}
