import { artifactFavoriteKeys } from "@repo/app/documents/hooks/artifact-favorite-keys";
import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import type { FixtureRoute } from "@repo/app/shared/storybook/fixture-fetch";
import { SidebarProvider } from "@repo/design-system/components/ui/sidebar";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import type { ReactNode } from "react";

/**
 * Mount wrapper for the Implementation Plan Detail Surface's prop-driven
 * header (`StoryPlanEditorHeader`): the app-core harness plus the two
 * providers the real `Header` needs — `SidebarProvider` for its
 * `SidebarTrigger`, `TooltipProvider` for the favorite button.
 */
export function PlanDetailHarness({
  children,
  apiRoutes,
  enabledFlags,
}: Readonly<{
  children: ReactNode;
  apiRoutes?: FixtureRoute[];
  enabledFlags?: readonly string[];
}>) {
  return (
    <AppCoreStoryProviders
      apiRoutes={apiRoutes}
      enabledFlags={enabledFlags}
      queryData={[[artifactFavoriteKeys.list(), []]]}
    >
      <TooltipProvider>
        <SidebarProvider>{children}</SidebarProvider>
      </TooltipProvider>
    </AppCoreStoryProviders>
  );
}
