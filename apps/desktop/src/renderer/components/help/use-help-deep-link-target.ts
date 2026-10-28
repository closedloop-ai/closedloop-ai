/**
 * ISS-10005 — the `/help?page=…&heading=…` deep link, resolved into the docs
 * hook's target seam.
 *
 * Its own module so BOTH branches read the deep link from one place without
 * depending on each other. A repeat pick carries a distinct query string → a
 * fresh target object → the hook re-selects and re-scrolls on the same page.
 */
import { useSearchParamsValue } from "@repo/navigation/use-search-params-value";
import { useMemo } from "react";
import {
  HELP_HEADING_PARAM,
  HELP_PAGE_PARAM,
} from "../../navigation/route-table";
import type { DocsHelpInitialTarget } from "./use-docs-help";

export function useHelpDeepLinkTarget(): DocsHelpInitialTarget | null {
  const searchParams = useSearchParamsValue();
  const targetPath = searchParams.get(HELP_PAGE_PARAM);
  const targetHeading = searchParams.get(HELP_HEADING_PARAM);
  return useMemo<DocsHelpInitialTarget | null>(
    () =>
      targetPath
        ? { path: targetPath, headingSlug: targetHeading ?? undefined }
        : null,
    [targetPath, targetHeading]
  );
}
