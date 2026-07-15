import { Toaster } from "@repo/design-system/components/ui/sonner";
import { TooltipProvider } from "@repo/design-system/components/ui/tooltip";
import { ThemeProvider } from "@repo/design-system/providers/theme";
import { createMemoryNavigation } from "@repo/navigation/memory-adapter";
import { NavigationProvider } from "@repo/navigation/provider";
import { withThemeByClassName } from "@storybook/addon-themes";
import type { Preview } from "@storybook/react";

import "@repo/design-system/styles/globals.css";
import "../../../packages/app/styles.css";

// Single in-memory navigation port for all stories: design-system and
// app-core components render the port `Link` / `usePath`, so the preview
// must mount an adapter the same way the web and desktop shells do.
const memoryNavigation = createMemoryNavigation();

const preview: Preview = {
  parameters: {
    options: {
      storySort: {
        order: ["Catalog", ["Inventory"], "Design System", "App Core"],
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
    (Story) => (
      <NavigationProvider adapter={memoryNavigation.adapter}>
        <div className="bg-background">
          <ThemeProvider>
            <TooltipProvider>
              <Story />
            </TooltipProvider>
            <Toaster />
          </ThemeProvider>
        </div>
      </NavigationProvider>
    ),
  ],
};

export default preview;
