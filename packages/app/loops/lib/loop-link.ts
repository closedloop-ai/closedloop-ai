import { cn } from "@repo/design-system/lib/utils";

// Shared className for the PR/branch hyperlinks rendered across loop views
// (loop detail + progress panel). Uses the theme-aware `--info` semantic token
// (`text-info`) instead of a hand-rolled `text-blue-600 dark:text-blue-400`
// pair, keeping light/dark in sync with the design system. Pass extra classes
// (e.g. a `mt-1`/`mt-2` margin) that vary per call site.
export const LOOP_LINK_CLASS_NAME =
  "inline-flex items-center gap-1.5 text-info text-xs hover:underline";

export function loopLinkClassName(className?: string): string {
  return cn(LOOP_LINK_CLASS_NAME, className);
}
