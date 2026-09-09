import { AppCoreStoryProviders } from "@repo/app/shared/storybook/decorators";
import { Toaster } from "@repo/design-system/components/ui/sonner";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { ThemeProvider } from "@repo/design-system/providers/theme";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";

// Wraps the design-system globals and adds the desktop-renderer source scan, so
// desktop stories render with real CSS. See the file for why that scan cannot
// live in globals.css itself, which four non-desktop surfaces also import.
import "@repo/design-system/styles/storybook.css";
import "../../../packages/app/styles.css";

// Single in-memory navigation port for all stories: design-system and
// app-core components render the port `Link` / `usePath`, so the preview
// must mount an adapter the same way the web and desktop shells do. It is
// handed to the app-core harness below rather than mounted separately, so
// every story resolves paths through exactly one adapter.
const memoryNavigation = createMemoryNavigation();

/**
 * Per-story configuration for the global app-core harness, declared the same
 * way `play` is — on the story, not as a wrapper around it:
 *
 *   export const Loaded: Story = {
 *     parameters: {
 *       appCore: {
 *         queryData: [[sessionKeys.detail(id), fixture]],
 *         enabledFlags: ["sessions-v2"],
 *       },
 *     },
 *   };
 *
 * Every story gets a QueryClient, auth, feature-flag, and API port for free, so
 * a component that calls `useQuery` renders without per-story boilerplate and
 * cannot fail simply because an author forgot to wrap it (ISS-5665).
 */
type AppCoreStoryParameters = Pick<
  Parameters<typeof AppCoreStoryProviders>[0],
  "queryData" | "apiRoutes" | "enabledFlags"
>;

const preview: Preview = {
  parameters: {
    options: {
      // Atomic-design reading order, top to bottom: tokens first, then the
      // primitives built from them, then the feature slices built from those,
      // then the desktop shell, and finally whole assembled screens. Catalog
      // sits above everything as the browsable index into the rest.
      storySort: {
        order: [
          "Catalog",
          ["Inventory"],
          "Foundations",
          ["Colors", "Typography", "Spacing", "Radius & Elevation", "Motion"],
          "Design System",
          "App Core",
          "Desktop",
          "Screens",
          ["Login", "Dashboard", "Settings"],
        ],
      },
    },
    controls: {
      matchers: {
        color: /(background|color)$/i,
        date: /Date$/i,
      },
    },
    chromatic: {
      modes: {
        light: {
          theme: "light",
          className: "light",
        },
        dark: {
          theme: "dark",
          className: "dark",
        },
      },
    },
  },
  decorators: [
    withThemeByClassName({
      themes: {
        light: "light",
        dark: "dark",
      },
      defaultTheme: "light",
    }),
    (Story, context) => {
      const appCore = (context.parameters.appCore ??
        {}) as AppCoreStoryParameters;
      return (
        <AppCoreStoryProviders
          apiRoutes={appCore.apiRoutes}
          enabledFlags={appCore.enabledFlags}
          navigationAdapter={memoryNavigation.adapter}
          queryData={appCore.queryData}
        >
          <div className="bg-background">
            <ThemeProvider>
              <TooltipProvider>
                <Story />
              </TooltipProvider>
              <Toaster />
            </ThemeProvider>
          </div>
        </AppCoreStoryProviders>
      );
    },
  ],
};

export default preview;
