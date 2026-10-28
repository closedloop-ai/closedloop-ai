import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import {
  type RenderOptions,
  type RenderResult,
  render as rtlRender,
} from "@testing-library/react";
import type { ReactElement, ReactNode } from "react";

/**
 * Drop-in replacement for Testing Library's `render` for any component in this
 * package that resolves routes through the navigation port (`useOrgPath`,
 * `useNavigation`, `Link`), which require a `<NavigationProvider>` ancestor;
 * mount the in-memory adapter so the org slug drives `/test-org/...` hrefs
 * without the Next shell.
 *
 * Lives in `shared/test-fixtures` rather than the document-table suite it was
 * written for because a navigation provider is not a documents concern, and
 * `shared/**` must never import a feature slice (`packages/app/AGENTS.md`) —
 * so a shared component's test cannot reach a helper parked inside `documents/`.
 */
export function render(
  ui: ReactElement,
  options?: Omit<RenderOptions, "wrapper">
): RenderResult {
  const nav = createMemoryNavigation({ orgSlug: "test-org" });
  return rtlRender(ui, {
    ...options,
    wrapper: ({ children }: { children: ReactNode }) => (
      <NavigationProvider adapter={nav.adapter}>{children}</NavigationProvider>
    ),
  });
}
